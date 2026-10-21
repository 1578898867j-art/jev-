import type { ApiError, ErrorCode } from '@ai-turtle-soup/shared';

const ERROR_DETAILS: Record<ErrorCode, { status: number; message: string; retryable: boolean }> = {
  INVALID_REQUEST: { status: 400, message: '请求内容无效，请检查后重试。', retryable: false },
  UNAUTHORIZED: { status: 401, message: '本局凭证无效，请返回题库重新开始。', retryable: false },
  PUZZLE_NOT_FOUND: { status: 404, message: '找不到这道题目。', retryable: false },
  SESSION_NOT_FOUND: { status: 404, message: '找不到当前游戏。', retryable: false },
  SESSION_EXPIRED: { status: 410, message: '本局已失效，请返回题库重新开始。', retryable: false },
  SESSION_ENDED: { status: 409, message: '本局已经结束。', retryable: false },
  REVISION_CONFLICT: { status: 409, message: '游戏状态已更新，请同步当前进度后再操作。', retryable: false },
  REQUEST_ID_REUSED: { status: 409, message: '请求编号已用于其他操作，请重新发起。', retryable: false },
  SESSION_BUSY: { status: 409, message: '当前操作仍在处理中，请稍后重试。', retryable: true },
  ACTION_NOT_ALLOWED: { status: 409, message: '当前游戏状态不支持此操作。', retryable: false },
  HINT_LIMIT_REACHED: { status: 409, message: '本局三次提示已用完。', retryable: false },
  HINT_UNAVAILABLE: { status: 409, message: '当前没有可用的提示方向。', retryable: false },
  AI_NOT_CONFIGURED: { status: 503, message: 'AI 未配置，提问和提示尚不可用。', retryable: false },
  AI_UNAVAILABLE: { status: 503, message: 'AI 暂不可用，本次未更新进度、未消耗提示。', retryable: true },
  AI_TIMEOUT: { status: 504, message: 'AI 响应超时，本次未更新进度、未消耗提示。', retryable: true },
  INVALID_MODEL_OUTPUT: { status: 502, message: 'AI 返回内容无法安全处理，本次未更新进度、未消耗提示。', retryable: true },
  OPERATION_CANCELLED: { status: 409, message: '该操作已随本局结束而取消。', retryable: false },
  RATE_LIMITED: { status: 429, message: '操作过于频繁，请稍后再试。', retryable: true },
  INTERNAL_ERROR: { status: 500, message: '服务暂时无法完成操作，请稍后重试。', retryable: true },
};

export class AppFault extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(code: ErrorCode, requestId?: string) {
    const detail = ERROR_DETAILS[code];
    super(detail.message);
    this.name = 'AppFault';
    this.status = detail.status;
    this.code = code;
    this.retryable = detail.retryable;
    this.requestId = requestId;
  }

  toBody(): ApiError {
    return {
      error: { code: this.code, message: this.message, retryable: this.retryable },
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export function asAppFault(error: unknown, requestId?: string): AppFault {
  if (error instanceof AppFault) {
    return requestId && !error.requestId ? new AppFault(error.code, requestId) : error;
  }
  return new AppFault('INTERNAL_ERROR', requestId);
}
