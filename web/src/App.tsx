import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  Judgment,
  PublicPuzzle,
  SessionStatus,
  SessionView,
} from '../../packages/shared/src/contracts.js';
import { ApiClient, ApiClientError, ApiRequestTimeoutError, resolveApiEndpoint } from './api.js';
import {
  emptyRetryAfterState,
  isRetryAfterActive,
  type RetryAfterState,
  withRetryAfter,
} from './retry-policy.js';

type Page = 'library' | 'game' | 'solution';
type HealthState = 'checking' | 'configured' | 'missing' | 'unavailable';
type PuzzleLoad = 'loading' | 'ready' | 'failed';
type AskKind = 'question' | 'hint';
type EndKind = 'reveal' | 'give-up';
type CalibrationResult = 'unchanged' | 'advanced' | 'unavailable' | 'stale';

type ActionIntent = {
  kind: AskKind;
  requestId: string;
  expectedRevision: number;
  text?: string;
};
type EndIntent = {
  kind: EndKind;
  requestId: string;
  expectedRevision: number;
};

const endpoint = resolveApiEndpoint(
  Capacitor.isNativePlatform(),
  import.meta.env.VITE_API_BASE_URL,
);

function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues) throw new Error('当前设备无法生成安全请求编号。');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isTerminal(status: SessionStatus): boolean {
  return status === 'completed' || status === 'given_up' || status === 'left';
}

export function canApplySessionSnapshot(current: SessionView, next: SessionView): boolean {
  if (current.id !== next.id || next.revision < current.revision) return false;
  if (isTerminal(current.status)) {
    if (current.status === 'left') return next.status === 'left';
    return next.status === current.status || next.status === 'left';
  }
  if (current.status === 'unlocked' && next.status === 'playing') return false;
  return true;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function judgmentLabel(judgment?: Judgment): string | undefined {
  if (!judgment) return undefined;
  return {
    yes: '是',
    no: '否',
    irrelevant: '无关',
    unknown: '无法确定',
    rephrase: '换个问法',
  }[judgment];
}

function actionErrorCopy(error: unknown, kind: AskKind): { message: string; retry: boolean; aiMissing?: boolean } {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'AI_NOT_CONFIGURED':
        return { message: 'AI 未配置，提问和提示尚不可用', retry: false, aiMissing: true };
      case 'AI_UNAVAILABLE':
        return { message: 'AI 暂不可用，本次未更新进度、未消耗提示。', retry: true };
      case 'AI_TIMEOUT':
        return { message: `等待超时，本次未更新进度、未消耗提示；可用同一请求重试。`, retry: true };
      case 'INVALID_MODEL_OUTPUT':
        return { message: '本次回应未通过校验，进度未更新、提示未消耗；可重试同一请求。', retry: true };
      case 'SESSION_BUSY':
        return { message: '另一项操作仍在处理；本次没有更新进度或消耗提示。', retry: true };
      case 'RATE_LIMITED':
        return {
          message: error.retryAfterSeconds === undefined
            ? '请求过于频繁，本次没有更新进度或消耗提示；稍后可重试同一请求。'
            : `请求过于频繁，本次没有更新进度或消耗提示；请等待 ${Math.ceil(error.retryAfterSeconds)} 秒后重试。`,
          retry: true,
        };
      case 'REVISION_CONFLICT':
        return { message: '本局进度刚刚变化，已重新读取；确认后可重新提交。', retry: false };
      case 'HINT_LIMIT_REACHED':
        return { message: '本局的三次提示已用完。', retry: false };
      case 'HINT_UNAVAILABLE':
        return { message: '当前没有可用的新提示方向，本次没有消耗提示。', retry: false };
      case 'OPERATION_CANCELLED':
        return { message: '本次操作已被结束动作取消。', retry: false };
      case 'SESSION_EXPIRED':
      case 'SESSION_NOT_FOUND':
      case 'UNAUTHORIZED':
        return { message: '本局已失效，请返回题库重新开始。', retry: false };
      case 'SESSION_ENDED':
      case 'ACTION_NOT_ALLOWED':
        return { message: '本局状态已变化，当前操作不可用。', retry: false };
      case 'INVALID_REQUEST':
        return { message: kind === 'question' ? '问题未能发送，请检查内容后再试。' : '提示暂不可用，请稍后再试。', retry: false };
      default:
        return error.retryable
          ? { message: '请求没有完成；当前进度与提示次数未在本页更新，可用同一请求重试。', retry: true }
          : { message: '请求未能完成，请稍后重试。', retry: false };
    }
  }
  return {
    message: '网络连接中断，服务端结果尚待确认；当前页面未更新进度或提示次数，安全重试会沿用同一请求。',
    retry: true,
  };
}

function sessionStatusText(status: SessionStatus): string {
  return {
    playing: '推理中',
    unlocked: '汤底已解锁',
    completed: '已看汤底',
    given_up: '已放弃',
    left: '已离开',
  }[status];
}

function StoryMark() {
  return (
    <svg className="story-mark" viewBox="0 0 88 64" aria-hidden="true">
      <path d="M11 48C22 13 55 9 77 25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".48" />
      <path d="M18 51C33 31 56 27 73 33" fill="none" stroke="currentColor" strokeWidth="1" opacity=".28" />
      <circle cx="21" cy="36" r="2.2" fill="currentColor" />
      <circle cx="45" cy="19" r="2.2" fill="currentColor" />
      <circle cx="70" cy="24" r="2.8" fill="currentColor" />
      <circle cx="57" cy="39" r="1.8" fill="currentColor" opacity=".72" />
      <path d="M70 17v-5m0 24v-5m7-7h5m-24 0h5" stroke="currentColor" strokeWidth="1" opacity=".5" />
    </svg>
  );
}

export default function App() {
  const api = useMemo(() => endpoint.base ? new ApiClient(endpoint.base) : null, []);
  const [page, setPage] = useState<Page>('library');
  const pageRef = useRef<Page>('library');
  const [puzzles, setPuzzles] = useState<PublicPuzzle[]>([]);
  const [puzzleLoad, setPuzzleLoad] = useState<PuzzleLoad>(endpoint.addressMissing ? 'failed' : 'loading');
  const [health, setHealth] = useState<HealthState>(endpoint.addressMissing ? 'unavailable' : 'checking');
  const [openingPuzzleId, setOpeningPuzzleId] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState('');
  const [session, setSession] = useState<SessionView | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const tokenRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const libraryLoadRef = useRef(0);
  const [question, setQuestion] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'info' | 'error'>('info');
  const [pendingAction, setPendingAction] = useState<AskKind | null>(null);
  const activeActionRef = useRef<{ requestId: string; controller: AbortController } | null>(null);
  const [retryIntent, setRetryIntent] = useState<ActionIntent | null>(null);
  const retryIntentRef = useRef<ActionIntent | null>(null);
  const [endRetryIntent, setEndRetryIntent] = useState<EndIntent | null>(null);
  const endRetryIntentRef = useRef<EndIntent | null>(null);
  const [endingBusy, setEndingBusy] = useState(false);
  const endingBusyRef = useRef(false);
  const endControllerRef = useRef<AbortController | null>(null);
  const [retryAfterState, setRetryAfterState] = useState<RetryAfterState>(emptyRetryAfterState);
  const retryAfterStateRef = useRef(retryAfterState);
  const [reloadVersion, setReloadVersion] = useState(0);

  const setCurrentPage = useCallback((next: Page) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const updateRetryIntent = useCallback((next: ActionIntent | null) => {
    retryIntentRef.current = next;
    setRetryIntent(next);
  }, []);

  const updateEndRetryIntent = useCallback((next: EndIntent | null) => {
    endRetryIntentRef.current = next;
    setEndRetryIntent(next);
  }, []);

  const updateRetryAfterState = useCallback((next: RetryAfterState) => {
    retryAfterStateRef.current = next;
    setRetryAfterState(next);
  }, []);

  const clearRetryAfter = useCallback(() => {
    updateRetryAfterState(emptyRetryAfterState());
  }, [updateRetryAfterState]);

  const recordRetryAfter = useCallback((error: unknown) => {
    if (!(error instanceof ApiClientError) || error.code !== 'RATE_LIMITED' || error.retryAfterAt === undefined) return;
    updateRetryAfterState(withRetryAfter(retryAfterStateRef.current, error.retryAfterAt));
  }, [updateRetryAfterState]);

  useEffect(() => {
    const deadline = retryAfterState.blockedUntil;
    if (deadline === null) return;
    const timer = window.setTimeout(() => {
      if (
        retryAfterStateRef.current.blockedUntil === deadline &&
        !isRetryAfterActive(retryAfterStateRef.current)
      ) clearRetryAfter();
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [clearRetryAfter, retryAfterState.blockedUntil]);

  const clearLocalSession = useCallback((message = '') => {
    generationRef.current += 1;
    sessionEpochRef.current += 1;
    clearRetryAfter();
    activeActionRef.current?.controller.abort();
    activeActionRef.current = null;
    endControllerRef.current?.abort();
    endControllerRef.current = null;
    sessionRef.current = null;
    tokenRef.current = null;
    setSession(null);
    setQuestion('');
    setPendingAction(null);
    setEndingBusy(false);
    endingBusyRef.current = false;
    updateRetryIntent(null);
    updateEndRetryIntent(null);
    setNotice('');
    setLibraryNotice(message);
    setCurrentPage('library');
  }, [clearRetryAfter, setCurrentPage, updateEndRetryIntent, updateRetryIntent]);

  const applySession = useCallback((next: SessionView, expectedId: string, generation: number): boolean => {
    if (generation !== generationRef.current || sessionRef.current?.id !== expectedId || next.id !== expectedId) return false;
    const current = sessionRef.current;
    if (!current || !canApplySessionSnapshot(current, next)) return false;

    sessionRef.current = next;
    setSession(next);
    if (next.status === 'completed' || next.status === 'given_up') {
      if (!isTerminal(current.status)) {
        sessionEpochRef.current += 1;
        activeActionRef.current?.controller.abort();
        activeActionRef.current = null;
        setPendingAction(null);
        updateRetryIntent(null);
        updateEndRetryIntent(null);
        endingBusyRef.current = false;
        setEndingBusy(false);
        endControllerRef.current = null;
      }
      setCurrentPage('solution');
    } else if (next.status === 'left') {
      clearLocalSession('本局已离开。');
    }
    return true;
  }, [clearLocalSession, setCurrentPage, updateEndRetryIntent, updateRetryIntent]);

  const isCurrentSession = useCallback((id: string, generation: number, epoch?: number) => {
    return generation === generationRef.current &&
      sessionRef.current?.id === id &&
      pageRef.current !== 'library' &&
      (epoch === undefined || epoch === sessionEpochRef.current);
  }, []);

  const calibrate = useCallback(async (
    id: string,
    token: string,
    generation: number,
    epoch: number,
  ): Promise<CalibrationResult> => {
    if (!api) return 'unavailable';
    const previousRevision = sessionRef.current?.revision;
    try {
      const result = await api.session(id, token);
      if (!isCurrentSession(id, generation, epoch) || previousRevision === undefined) return 'stale';
      const applied = applySession(result.session, id, generation);
      if (!applied) return 'stale';
      return result.session.revision > previousRevision ? 'advanced' : 'unchanged';
    } catch (error) {
      if (!isCurrentSession(id, generation, epoch)) return 'stale';
      recordRetryAfter(error);
      if (error instanceof ApiClientError && ['SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'UNAUTHORIZED'].includes(error.code)) {
        clearLocalSession('本局已失效，请从题库重新开始。');
        return 'stale';
      }
      return 'unavailable';
    }
  }, [api, applySession, clearLocalSession, isCurrentSession, recordRetryAfter]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const loadId = ++libraryLoadRef.current;
    const generation = generationRef.current;
    setPuzzleLoad('loading');
    setHealth('checking');

    void Promise.allSettled([
      api.health(controller.signal),
      api.puzzles(controller.signal),
    ]).then(([healthResult, puzzleResult]) => {
      if (controller.signal.aborted || loadId !== libraryLoadRef.current || generation !== generationRef.current) return;
      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value.ai.configured ? 'configured' : 'missing');
      } else {
        recordRetryAfter(healthResult.reason);
        setHealth('unavailable');
      }
      if (puzzleResult.status === 'fulfilled') {
        setPuzzles(puzzleResult.value.puzzles);
        setPuzzleLoad('ready');
      } else {
        recordRetryAfter(puzzleResult.reason);
        setPuzzleLoad('failed');
        const error = puzzleResult.reason;
        setLibraryNotice(error instanceof ApiClientError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== undefined
          ? `请求过于频繁，请等待 ${Math.ceil(error.retryAfterSeconds)} 秒后再加载题库。`
          : '题库暂时无法加载，请检查连接后重试。');
      }
    });

    return () => controller.abort();
  }, [api, recordRetryAfter, reloadVersion]);

  const beginPuzzle = useCallback(async (puzzle: PublicPuzzle) => {
    if (!api || openingPuzzleId) return;
    if (isRetryAfterActive(retryAfterStateRef.current)) {
      setLibraryNotice('服务端要求等待后再试；等待期结束前不能开始新局。');
      return;
    }
    const generation = ++generationRef.current;
    setOpeningPuzzleId(puzzle.id);
    setLibraryNotice('');
    const controller = new AbortController();
    try {
      const created = await api.createSession(puzzle.id, controller.signal);
      if (generation !== generationRef.current || pageRef.current !== 'library') {
        const orphanLeave = new AbortController();
        void api.action('leave', created.session.id, created.sessionToken, createRequestId(), created.session.revision, undefined, orphanLeave.signal).catch(() => undefined);
        return;
      }
      clearRetryAfter();
      tokenRef.current = created.sessionToken;
      sessionRef.current = created.session;
      setSession(created.session);
      setQuestion('');
      setNotice('');
      setPendingAction(null);
      updateRetryIntent(null);
      updateEndRetryIntent(null);
      setCurrentPage('game');
    } catch (error) {
      if (generation === generationRef.current) {
        recordRetryAfter(error);
        setLibraryNotice(error instanceof ApiClientError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== undefined
          ? `请求过于频繁，请等待 ${Math.ceil(error.retryAfterSeconds)} 秒后再开始。`
          : '暂时无法开始本局，请检查连接后重试。');
      }
    } finally {
      if (generation === generationRef.current) setOpeningPuzzleId(null);
    }
  }, [api, clearRetryAfter, openingPuzzleId, recordRetryAfter, setCurrentPage, updateEndRetryIntent, updateRetryIntent]);

  const executeAsk = useCallback(async (intent: ActionIntent) => {
    const current = sessionRef.current;
    const token = tokenRef.current;
    if (!api || !current || !token || current.status !== 'playing' || pendingAction || activeActionRef.current || endingBusyRef.current || endRetryIntentRef.current) return;
    if (isRetryAfterActive(retryAfterStateRef.current)) {
      setNotice('服务端要求等待后再试；等待期结束前不会重发本次请求。');
      setNoticeTone('info');
      return;
    }
    if (intent.expectedRevision !== current.revision && retryIntentRef.current?.requestId !== intent.requestId) {
      setNotice('本局进度已变化，请确认当前状态后重新操作。');
      setNoticeTone('info');
      return;
    }

    const generation = generationRef.current;
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    activeActionRef.current = { requestId: intent.requestId, controller };
    setPendingAction(intent.kind);
    setNotice('');
    try {
      const response = await api.action(
        intent.kind,
        current.id,
        token,
        intent.requestId,
        intent.expectedRevision,
        intent.text,
        controller.signal,
      );
      if (!isCurrentSession(current.id, generation, epoch) || response.requestId !== intent.requestId) return;
      const applied = applySession(response.session, current.id, generation);
      if (!applied) return;
      if (retryIntentRef.current?.requestId === intent.requestId) updateRetryIntent(null);
      if (intent.kind === 'question' && question.trim() === intent.text) setQuestion('');
      setNotice('');
    } catch (error) {
      if (controller.signal.aborted || !isCurrentSession(current.id, generation, epoch) || pageRef.current !== 'game') return;
      if (error instanceof ApiClientError && error.code === 'OPERATION_CANCELLED' && endingBusyRef.current) return;
      if (error instanceof ApiClientError && error.code === 'REVISION_CONFLICT') {
        const calibration = await calibrate(current.id, token, generation, epoch);
        updateRetryIntent(null);
        if (pageRef.current === 'game' && isCurrentSession(current.id, generation)) {
          setNotice(calibration === 'unavailable'
            ? '本局进度冲突，暂时无法读取最新状态。输入仍保留；重新发送时会先校准。'
            : '已重新读取本局状态；这次操作没有自动重发，请确认后再次提交。');
          setNoticeTone(calibration === 'unavailable' ? 'error' : 'info');
        }
        return;
      }
      if (error instanceof ApiClientError && ['SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'UNAUTHORIZED'].includes(error.code)) {
        clearLocalSession('本局已失效，请从题库重新开始。');
        return;
      }
      if (!(error instanceof ApiClientError)) {
        updateRetryIntent(intent);
        const calibration = await calibrate(current.id, token, generation, epoch);
        if (!isCurrentSession(current.id, generation, epoch) || pageRef.current !== 'game') return;
        const message = calibration === 'advanced'
          ? error instanceof ApiRequestTimeoutError
            ? '请求等待超时，服务端结果尚未确认；刚读取的进度已有变化，可用同一请求编号安全重试。'
            : '已读取服务端最新进度；原请求结果尚待确认，可用同一请求编号安全重试。'
          : calibration === 'unchanged'
            ? error instanceof ApiRequestTimeoutError
              ? '请求等待超时，服务端结果尚未确认；刚读取的快照暂未变化。可用同一请求编号安全重试。'
              : '截至刚才校准时，进度未更新、提示次数未扣；可用同一请求编号重试。'
            : error instanceof ApiRequestTimeoutError
              ? '请求等待超时，服务端结果尚未确认；本页没有自行修改进度或提示次数，安全重试会沿用同一请求编号。'
              : '网络连接中断，服务端结果尚未确认；本页未更新进度或提示次数，安全重试会沿用同一请求。';
        setNotice(message);
        setNoticeTone('error');
      } else {
        recordRetryAfter(error);
        const copy = actionErrorCopy(error, intent.kind);
        if (copy.aiMissing) setHealth('missing');
        setNotice(copy.message);
        setNoticeTone(copy.aiMissing ? 'error' : copy.retry ? 'error' : 'info');
        updateRetryIntent(copy.retry ? intent : null);
      }
    } finally {
      if (activeActionRef.current?.requestId === intent.requestId) {
        activeActionRef.current = null;
        if (generation === generationRef.current && epoch === sessionEpochRef.current) setPendingAction(null);
      }
    }
  }, [api, applySession, calibrate, clearLocalSession, isCurrentSession, pendingAction, question, recordRetryAfter, updateRetryIntent]);

  const submitQuestion = useCallback(() => {
    const current = sessionRef.current;
    if (!current || health !== 'configured') return;
    const text = question.trim();
    if (!text || countCodePoints(text) > 500) return;
    const prior = retryIntentRef.current;
    if (prior?.kind === 'question' && prior.text === text && prior.expectedRevision === current.revision) {
      void executeAsk(prior);
      return;
    }
    if (prior) return;
    try {
      void executeAsk({ kind: 'question', requestId: createRequestId(), expectedRevision: current.revision, text });
    } catch {
      setNotice('当前设备无法生成安全请求编号，请更新系统后重试。');
      setNoticeTone('error');
    }
  }, [executeAsk, health, question]);

  const requestHint = useCallback(() => {
    const current = sessionRef.current;
    if (!current || health !== 'configured') return;
    const prior = retryIntentRef.current;
    if (prior?.kind === 'hint' && prior.expectedRevision === current.revision) {
      void executeAsk(prior);
      return;
    }
    if (prior) return;
    try {
      void executeAsk({ kind: 'hint', requestId: createRequestId(), expectedRevision: current.revision });
    } catch {
      setNotice('当前设备无法生成安全请求编号，请更新系统后重试。');
      setNoticeTone('error');
    }
  }, [executeAsk, health]);

  const submitEndAction = useCallback(async (kind: EndKind) => {
    const current = sessionRef.current;
    const token = tokenRef.current;
    if (!api || !current || !token || endingBusyRef.current) return;
    if (kind === 'reveal' && current.status !== 'unlocked') return;
    if (kind === 'give-up' && current.status !== 'playing') return;

    const previous = endRetryIntentRef.current;
    if (previous?.kind === kind && isRetryAfterActive(retryAfterStateRef.current)) return;
    let intent: EndIntent;
    if (previous?.kind === kind) {
      intent = previous;
    } else {
      try {
        intent = { kind, requestId: createRequestId(), expectedRevision: current.revision };
      } catch {
        setNotice('当前设备无法生成安全请求编号，请更新系统后重试。');
        setNoticeTone('error');
        return;
      }
      updateEndRetryIntent(null);
    }

    const generation = generationRef.current;
    const epoch = sessionEpochRef.current;
    const controller = new AbortController();
    endControllerRef.current = controller;
    endingBusyRef.current = true;
    setEndingBusy(true);
    setNotice('');
    try {
      const response = await api.action(kind, current.id, token, intent.requestId, intent.expectedRevision, undefined, controller.signal);
      if (!isCurrentSession(current.id, generation, epoch) || response.requestId !== intent.requestId) return;
      const applied = applySession(response.session, current.id, generation);
      if (applied) {
        updateRetryIntent(null);
        updateEndRetryIntent(null);
      }
    } catch (error) {
      if (controller.signal.aborted || !isCurrentSession(current.id, generation, epoch)) return;
      recordRetryAfter(error);
      if (error instanceof ApiClientError && ['SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'UNAUTHORIZED'].includes(error.code)) {
        clearLocalSession('本局已失效，请从题库重新开始。');
        return;
      }
      if (error instanceof ApiClientError && error.code === 'REVISION_CONFLICT') {
        const calibration = await calibrate(current.id, token, generation, epoch);
        updateEndRetryIntent(null);
        if (pageRef.current === 'game' && isCurrentSession(current.id, generation)) {
          setNotice(calibration === 'unavailable'
            ? '无法读取本局最新状态，请保持连接后再次选择结束操作。'
            : '已重新读取本局状态；请确认后再次选择结束操作。');
          setNoticeTone(calibration === 'unavailable' ? 'error' : 'info');
        }
        return;
      }
      if (!(error instanceof ApiClientError)) {
        const calibration = await calibrate(current.id, token, generation, epoch);
        if (!isCurrentSession(current.id, generation, epoch) || pageRef.current !== 'game') return;
        updateEndRetryIntent(intent);
        setNotice(error instanceof ApiRequestTimeoutError
          ? `结束操作等待超时，服务端结果尚未确认${calibration === 'advanced' ? '；刚读取的进度已有变化' : ''}，安全重试会沿用同一请求编号。`
          : calibration === 'advanced'
            ? '已读取服务端最新进度；结束操作结果尚待确认，可用同一请求编号安全重试。'
            : '结束状态尚未确认，当前页面保留本局；安全重试会沿用同一请求编号。');
      } else {
        updateEndRetryIntent(error.retryable ? intent : null);
        setNotice(error.retryable
          ? '结束操作尚未完成；本局仍在当前页面，可用同一请求编号重试。'
          : '结束操作未完成，请确认本局当前状态后重试。');
      }
      setNoticeTone('error');
    } finally {
      if (generation === generationRef.current && epoch === sessionEpochRef.current) {
        endingBusyRef.current = false;
        endControllerRef.current = null;
        setEndingBusy(false);
      }
    }
  }, [api, applySession, calibrate, clearLocalSession, isCurrentSession, recordRetryAfter, updateEndRetryIntent, updateRetryIntent]);

  const returnToLibrary = useCallback(() => {
    const oldSession = sessionRef.current;
    const oldToken = tokenRef.current;
    const oldGeneration = generationRef.current;
    const newGeneration = oldGeneration + 1;
    generationRef.current = newGeneration;
    sessionEpochRef.current += 1;
    clearRetryAfter();
    activeActionRef.current?.controller.abort();
    activeActionRef.current = null;
    endControllerRef.current?.abort();
    endControllerRef.current = null;
    sessionRef.current = null;
    tokenRef.current = null;
    setSession(null);
    setQuestion('');
    setPendingAction(null);
    setEndingBusy(false);
    endingBusyRef.current = false;
    updateRetryIntent(null);
    updateEndRetryIntent(null);
    setNotice('');
    setLibraryNotice('');
    setCurrentPage('library');

    if (oldSession && oldToken && api) {
      let requestId: string;
      try {
        requestId = createRequestId();
      } catch {
        return;
      }
      const leaveController = new AbortController();
      void api.action('leave', oldSession.id, oldToken, requestId, oldSession.revision, undefined, leaveController.signal)
        .catch(() => undefined);
    }
  }, [api, clearRetryAfter, setCurrentPage, updateEndRetryIntent, updateRetryIntent]);

  const retryCurrent = useCallback(() => {
    if (isRetryAfterActive(retryAfterStateRef.current)) return;
    const intent = retryIntentRef.current;
    if (!intent) return;
    void executeAsk(intent);
  }, [executeAsk]);

  const retryEndAction = useCallback(() => {
    if (isRetryAfterActive(retryAfterStateRef.current)) return;
    const intent = endRetryIntentRef.current;
    if (!intent) return;
    void submitEndAction(intent.kind);
  }, [submitEndAction]);

  const aiUnavailableText = health === 'missing'
    ? 'AI 未配置，提问和提示尚不可用'
    : health === 'unavailable'
      ? '暂无法读取 AI 配置，提问和提示当前不可用。'
      : health === 'checking'
        ? '正在读取 AI 配置状态…'
        : '';
  const retryBlocked = isRetryAfterActive(retryAfterState, Date.now());

  return (
    <div className="app-shell">
      {page === 'library' && (
        <LibraryPage
          puzzles={puzzles}
          loadState={puzzleLoad}
          notice={libraryNotice}
          openingPuzzleId={openingPuzzleId}
          addressMissing={endpoint.addressMissing}
          retryBlocked={retryBlocked}
          onOpenPuzzle={beginPuzzle}
          onReload={() => setReloadVersion((value) => value + 1)}
        />
      )}
      {page === 'game' && session && (
        <GamePage
          session={session}
          question={question}
          aiState={health}
          aiUnavailableText={aiUnavailableText}
          notice={notice}
          noticeTone={noticeTone}
          pendingAction={pendingAction}
          retryIntent={retryIntent}
          endRetryIntent={endRetryIntent}
          retryBlocked={retryBlocked}
          endingBusy={endingBusy}
          onQuestionChange={setQuestion}
          onSubmitQuestion={submitQuestion}
          onRequestHint={requestHint}
          onRetry={retryCurrent}
          onRetryEnd={retryEndAction}
          onGiveUp={() => void submitEndAction('give-up')}
          onReveal={() => void submitEndAction('reveal')}
          onReturn={returnToLibrary}
        />
      )}
      {page === 'solution' && session && (
        <SolutionPage
          session={session}
          notice={notice}
          endingBusy={endingBusy}
          onReturn={returnToLibrary}
        />
      )}
    </div>
  );
}

function LibraryPage(props: {
  puzzles: PublicPuzzle[];
  loadState: PuzzleLoad;
  notice: string;
  openingPuzzleId: string | null;
  addressMissing: boolean;
  retryBlocked: boolean;
  onOpenPuzzle: (puzzle: PublicPuzzle) => void;
  onReload: () => void;
}) {
  return (
    <main className="page library-page">
      <header className="topbar">
        <div className="brand-signature">
          <span className="brand-mark" aria-hidden="true"><StoryMark /></span>
          <strong>AI 海龟汤</strong>
        </div>
        <span className="topbar-note">观测站 · 谜题簿</span>
      </header>

      <section className="library-intro" aria-labelledby="library-title">
        <p className="section-kicker">观测记录</p>
        <h1 id="library-title">选一道汤面</h1>
        <p className="intro-copy">从公开的故事开始提问，逐步拼起必要线索。</p>
        <div className="observatory-line" aria-hidden="true">
          <span /><span /><span /><span />
        </div>
      </section>

      {props.addressMissing && (
        <div className="notice notice-error" role="alert">
          <strong>服务地址未配置</strong>
          <span>此应用运行在原生环境中。请设置公开的 VITE_API_BASE_URL 后重新构建。</span>
        </div>
      )}
      {props.retryBlocked && !props.addressMissing && (
        <div className="notice notice-soft" role="status">服务端要求稍后再试，等待期结束后可开始新局或重试读取。</div>
      )}
      {!props.addressMissing && props.notice && <div className="notice notice-error" role="alert">{props.notice}</div>}

      <section className="puzzle-section" aria-labelledby="puzzle-list-title">
        <div className="section-heading">
          <h2 id="puzzle-list-title">题库</h2>
          {props.loadState === 'ready' && <span className="quiet-count">{props.puzzles.length} 道</span>}
        </div>
        {props.loadState === 'loading' && <div className="loading-row" role="status">正在从题库读取故事…</div>}
        {props.loadState === 'failed' && !props.addressMissing && (
          <div className="empty-state">
            <p>暂时无法连接题库。</p>
          <button className="button button-secondary" type="button" onClick={props.onReload} disabled={props.retryBlocked}>重新加载</button>
          </div>
        )}
        {props.loadState === 'ready' && props.puzzles.length === 0 && (
          <div className="empty-state"><p>题库暂时没有可玩的汤面。</p></div>
        )}
        {props.loadState === 'ready' && props.puzzles.length > 0 && (
          <div className="puzzle-list">
            {props.puzzles.map((puzzle) => (
              <article className="puzzle-row" key={`${puzzle.id}:${puzzle.version}`}>
                <div className="puzzle-mark" aria-hidden="true" />
                <div className="puzzle-copy">
                  <h3>{puzzle.title}</h3>
                  <p>{puzzle.surface}</p>
                  <span className="puzzle-meta">需要发现 {puzzle.requiredClueCount} 条线索</span>
                </div>
                <button
                  className="button button-primary puzzle-start"
                  type="button"
                  disabled={props.openingPuzzleId !== null || props.retryBlocked}
                  onClick={() => props.onOpenPuzzle(puzzle)}
                  aria-label={`开始谜题：${puzzle.title}`}
                >
                  {props.openingPuzzleId === puzzle.id ? '正在开始…' : props.retryBlocked ? '请稍候' : '开始'}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className="page-footnote">汤底会在集齐线索或主动放弃后显示。</footer>
    </main>
  );
}

function GamePage(props: {
  session: SessionView;
  question: string;
  aiState: HealthState;
  aiUnavailableText: string;
  notice: string;
  noticeTone: 'info' | 'error';
  pendingAction: AskKind | null;
  retryIntent: ActionIntent | null;
  endRetryIntent: EndIntent | null;
  retryBlocked: boolean;
  endingBusy: boolean;
  onQuestionChange: (value: string) => void;
  onSubmitQuestion: () => void;
  onRequestHint: () => void;
  onRetry: () => void;
  onRetryEnd: () => void;
  onGiveUp: () => void;
  onReveal: () => void;
  onReturn: () => void;
}) {
  const { session } = props;
  const canAsk = session.status === 'playing' && props.aiState === 'configured' && !props.pendingAction && !props.endingBusy && !props.retryIntent && !props.endRetryIntent && !props.retryBlocked;
  const isPlaying = session.status === 'playing';
  const remaining = Math.max(0, session.puzzle.requiredClueCount - session.discoveredClues.length);
  const charCount = countCodePoints(props.question);

  return (
    <main className="page game-page">
      <header className="game-topbar">
        <button className="text-button back-button" type="button" onClick={props.onReturn} aria-label="返回题库并离开本局">
          <span aria-hidden="true">←</span> 题库
        </button>
        <span className="session-status"><span className="status-dot" />{sessionStatusText(session.status)}</span>
      </header>

      <div className="game-heading">
        <p className="section-kicker">本局故事</p>
        <h1>{session.puzzle.title}</h1>
        <details className="surface-fold" open>
          <summary>汤面</summary>
          <p>{session.puzzle.surface}</p>
        </details>
      </div>

      <section className="clue-progress" aria-labelledby="progress-title">
        <div className="progress-copy">
          <div>
            <h2 id="progress-title">线索进度</h2>
            <p>{session.discoveredClues.length} / {session.puzzle.requiredClueCount} 条必要线索</p>
          </div>
          <span className="progress-ratio" aria-label={`已发现 ${session.discoveredClues.length} 条，共 ${session.puzzle.requiredClueCount} 条`}>
            {session.discoveredClues.length}<span> / {session.puzzle.requiredClueCount}</span>
          </span>
        </div>
        <div className="progress-track" role="img" aria-label={`线索完成 ${session.discoveredClues.length} 条，共 ${session.puzzle.requiredClueCount} 条`}>
          {Array.from({ length: session.puzzle.requiredClueCount }, (_, index) => (
            <span className={index < session.discoveredClues.length ? 'progress-unit is-found' : 'progress-unit'} key={index} />
          ))}
        </div>
        {session.discoveredClues.length > 0 && (
          <div className="discovered-list" aria-label="已发现线索">
            {session.discoveredClues.map((clue) => (
              <article className="discovered-clue" key={clue.id}>
                <span className="clue-kind">{clue.kind === 'fact' ? '事实' : '因果'}</span>
                <p>{clue.publicText}</p>
              </article>
            ))}
          </div>
        )}
        {remaining > 0 && <p className="unfound-note">还有 {remaining} 条必要线索待发现</p>}
      </section>

      {props.aiUnavailableText && (
        <div className={`notice ${props.aiState === 'missing' ? 'notice-error' : 'notice-soft'}`} role={props.aiState === 'missing' ? 'alert' : 'status'}>
          <strong>{props.aiUnavailableText}</strong>
          {props.aiState === 'missing' && <span>你仍可放弃并查看真实汤底。</span>}
        </div>
      )}
      {props.notice && <div className={`notice ${props.noticeTone === 'error' ? 'notice-error' : 'notice-soft'}`} role={props.noticeTone === 'error' ? 'alert' : 'status'}>{props.notice}</div>}
      {props.endRetryIntent && (
        <button className="button button-retry" type="button" onClick={props.onRetryEnd} disabled={props.endingBusy || props.retryBlocked}>
          {props.endingBusy ? '正在重试结束操作…' : props.retryBlocked ? '等待后再重试结束操作' : props.endRetryIntent.kind === 'reveal' ? '用同一请求重试查看汤底' : '用同一请求重试放弃'}
        </button>
      )}

      {session.status === 'unlocked' && (
        <div className="unlock-strip">
          <span>必要线索已经集齐</span>
          <button className="button button-primary" type="button" disabled={props.endingBusy} onClick={props.onReveal}>
            {props.endingBusy ? '正在读取…' : '查看汤底'}
          </button>
        </div>
      )}

      <section className="conversation" aria-label="本局对话" aria-live="polite" aria-relevant="additions text">
        {session.messages.length === 0 ? (
          <div className="conversation-empty">
            <span className="empty-orbit" aria-hidden="true"><i /><b /></span>
            <p>从一个问题开始推理。</p>
          </div>
        ) : (
          session.messages.map((message) => <MessageRow key={message.id} message={message} />)
        )}
        {props.pendingAction && (
          <div className="working-line" role="status"><span className="working-dot" />{props.pendingAction === 'question' ? '正在判断这个问题…' : '正在准备提示…'}</div>
        )}
      </section>

      {isPlaying && (
        <section className="composer" aria-label="提问与本局操作">
          <form className="question-form" onSubmit={(event) => { event.preventDefault(); props.onSubmitQuestion(); }}>
            <label htmlFor="question-input">提出你的问题</label>
            <div className="input-row">
              <textarea
                id="question-input"
                rows={2}
                value={props.question}
                maxLength={1000}
                readOnly={!!props.retryIntent || !!props.endRetryIntent}
                disabled={props.endingBusy || props.pendingAction !== null}
                placeholder="输入你的推理问题"
                onChange={(event) => {
                  const points = Array.from(event.currentTarget.value);
                  props.onQuestionChange(points.slice(0, 500).join(''));
                }}
                aria-describedby="question-help"
              />
              <button className="button button-primary send-button" type="submit" disabled={!canAsk || !props.question.trim() || charCount > 500}>
                {props.pendingAction === 'question' ? '发送中…' : '发送'}
              </button>
            </div>
            <div className="input-footer" id="question-help">
              <span>{props.endRetryIntent ? '确认结束结果后才能继续提问' : props.retryIntent ? '重试后才能编辑本次问题' : '尽量一次只问一件事'}</span>
              <span>{charCount} / 500</span>
            </div>
          </form>

          {props.retryIntent && !props.endRetryIntent && (
            <button className="button button-retry" type="button" onClick={props.onRetry} disabled={props.pendingAction !== null || props.endingBusy || props.retryBlocked}>
              {props.pendingAction ? '正在重试…' : props.retryBlocked ? '等待后再重试' : props.retryIntent.kind === 'question' ? '用同一请求重试问题' : '用同一请求重试提示'}
            </button>
          )}

          <div className="secondary-actions">
            <button className="button button-secondary" type="button" disabled={props.aiState !== 'configured' || session.hintsUsed >= 3 || !!props.pendingAction || props.endingBusy || !!props.retryIntent || !!props.endRetryIntent || props.retryBlocked} onClick={props.onRequestHint}>
              {session.hintsUsed >= 3 ? '提示已用完' : '提示'} <span className="hint-count">{session.hintsUsed} / 3</span>
            </button>
            <button className="button button-quiet-danger" type="button" disabled={props.endingBusy} onClick={props.onGiveUp}>
              {props.endingBusy ? '正在结束…' : '放弃并看汤底'}
            </button>
          </div>
        </section>
      )}

      {session.status === 'unlocked' && <p className="end-note">查看汤底后，本局才会标记为完成。</p>}
    </main>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isPlayer = message.role === 'player';
  const label = isPlayer ? '你' : message.role === 'hint' ? '提示' : '主持人';
  return (
    <article className={`message-row ${isPlayer ? 'message-player' : ''} ${message.role === 'hint' ? 'message-hint' : ''}`}>
      <span className="message-author">{label}</span>
      <div className="message-content">
        <p>{message.text}</p>
        {message.role === 'host' && message.judgment && <span className="judgment-chip">{judgmentLabel(message.judgment)}</span>}
      </div>
    </article>
  );
}

function SolutionPage(props: {
  session: SessionView;
  notice: string;
  endingBusy: boolean;
  onReturn: () => void;
}) {
  const { session } = props;
  const gaveUp = session.status === 'given_up';
  return (
    <main className="page solution-page">
      <header className="game-topbar">
        <span className="brand-small"><StoryMark /> 观测站 · 记录</span>
        <span className="session-status"><span className="status-dot status-dot-done" />{sessionStatusText(session.status)}</span>
      </header>

      <section className="solution-heading" aria-labelledby="solution-title">
        <div className="solution-seal" aria-hidden="true"><span>✓</span></div>
        <p className="section-kicker">本局结束</p>
        <h1 id="solution-title">{gaveUp ? '汤底揭晓' : '线索已拼合'}</h1>
        <p>{gaveUp ? '你选择结束推理，以下是这个故事的完整解释。' : '你已发现全部必要线索，并主动查看汤底。'}</p>
      </section>

      {props.notice && <div className="notice notice-error" role="alert">{props.notice}</div>}
      <article className="solution-card">
        <div className="solution-card-head">
          <div>
            <span className="solution-label">汤底</span>
            <h2>{session.puzzle.title}</h2>
          </div>
          <StoryMark />
        </div>
        {session.solution?.text ? (
          <p className="solution-text">{session.solution.text}</p>
        ) : (
          <p className="solution-missing">汤底暂时无法显示。请返回题库后重新开始。</p>
        )}
        <div className="solution-result">
          <span>{session.discoveredClues.length} / {session.puzzle.requiredClueCount} 条线索</span>
          <span>已使用 {session.hintsUsed} 次提示</span>
        </div>
      </article>

      <button className="button button-primary return-button" type="button" onClick={props.onReturn} disabled={props.endingBusy}>
        返回题库
      </button>
    </main>
  );
}
