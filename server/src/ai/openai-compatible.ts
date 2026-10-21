import type { HintModelOutput, QuestionModelOutput } from '@ai-turtle-soup/shared';
import { AppFault } from '../errors.js';
import { buildHintUserMessage, buildQuestionUserMessage, HINT_SYSTEM_PROMPT, QA_SYSTEM_PROMPT } from './prompts.js';
import { parseHintModelOutput, parseQuestionModelOutput } from './validation.js';
import type { AiAdapter, HintModelInput, QuestionModelInput } from './types.js';

export interface OpenAiCompatibleConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  thinking?: string;
}

export interface OpenAiCompatibleOptions {
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

const BEIJING_HOST_SUFFIX = '.cn-beijing.maas.aliyuncs.com';
const BEIJING_BASE_PATH = '/compatible-mode/v1';
const GLM_BEIJING_MODEL = 'ZHIPU/GLM-5.3-Flash';
const QWEN_BEIJING_MODEL = 'qwen3.8-flash';

function usesBeijingWorkspaceBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    return url.protocol === 'https:'
      && url.hostname.toLowerCase().endsWith(BEIJING_HOST_SUFFIX)
      && url.hostname.length > BEIJING_HOST_SUFFIX.length
      && path === BEIJING_BASE_PATH;
  } catch {
    return false;
  }
}

function usesBeijingGlmProfile(baseUrl: string | undefined, model: string | undefined): boolean {
  return model === GLM_BEIJING_MODEL && usesBeijingWorkspaceBaseUrl(baseUrl);
}

function usesBeijingQwenProfile(baseUrl: string | undefined, model: string | undefined): boolean {
  return model === QWEN_BEIJING_MODEL && usesBeijingWorkspaceBaseUrl(baseUrl);
}

export class AiAdapterFault extends Error {
  constructor(readonly code: 'AI_NOT_CONFIGURED' | 'AI_UNAVAILABLE' | 'AI_TIMEOUT' | 'INVALID_MODEL_OUTPUT' | 'OPERATION_CANCELLED') {
    super(code);
    this.name = 'AiAdapterFault';
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
}

export function createOpenAiCompatibleAdapter(
  config: OpenAiCompatibleConfig,
  options: OpenAiCompatibleOptions = {},
): AiAdapter {
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '');
  const model = config.model?.trim();
  const apiKey = config.apiKey?.trim();
  const configuredThinking = config.thinking?.trim();
  const isBeijingGlm = usesBeijingGlmProfile(baseUrl, model);
  const isBeijingQwen = usesBeijingQwenProfile(baseUrl, model);
  if (configuredThinking && configuredThinking !== 'enabled' && configuredThinking !== 'disabled') {
    throw new Error('AI_THINKING must be "enabled" or "disabled" when set');
  }
  if (isBeijingGlm && configuredThinking === 'disabled') {
    throw new Error('AI_THINKING=disabled is not supported for the configured GLM profile');
  }
  const configured = Boolean(baseUrl && model && apiKey);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxTokens = options.maxTokens ?? (isBeijingGlm ? 8_192 : 2_048);
  const maxCompletionTokens = options.maxTokens ?? 2_048;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function complete(system: string, user: string, signal: AbortSignal): Promise<unknown> {
    if (!configured || !baseUrl || !model || !apiKey) throw new AiAdapterFault('AI_NOT_CONFIGURED');

    let endpoint: URL;
    try {
      const endpointPath = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
      endpoint = new URL(endpointPath);
    } catch {
      throw new AiAdapterFault('AI_UNAVAILABLE');
    }
    const isDeepSeek = endpoint.hostname.toLowerCase() === 'api.deepseek.com';

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            ...(isBeijingQwen ? { max_completion_tokens: maxCompletionTokens } : { max_tokens: maxTokens }),
            response_format: { type: 'json_object' },
            ...(isBeijingQwen
              ? {
                enable_thinking: configuredThinking === 'enabled',
                ...(configuredThinking === 'enabled' ? { reasoning_effort: 'low' } : {}),
              }
              : isBeijingGlm
                ? { enable_thinking: true, reasoning_effort: 'low' }
                : isDeepSeek ? { thinking: { type: configuredThinking ?? 'disabled' } } : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        if (timedOut) throw new AiAdapterFault('AI_TIMEOUT');
        if (signal.aborted) throw new AiAdapterFault('OPERATION_CANCELLED');
        throw new AiAdapterFault('AI_UNAVAILABLE');
      }

      if (!response.ok) throw new AiAdapterFault('AI_UNAVAILABLE');

      let payload: ChatCompletionResponse;
      try {
        payload = await response.json() as ChatCompletionResponse;
      } catch {
        if (timedOut) throw new AiAdapterFault('AI_TIMEOUT');
        if (signal.aborted) throw new AiAdapterFault('OPERATION_CANCELLED');
        throw new AiAdapterFault('INVALID_MODEL_OUTPUT');
      }
      const content = payload.choices?.[0]?.message?.content;
      if (payload.choices?.[0]?.finish_reason === 'length') {
        throw new AiAdapterFault('INVALID_MODEL_OUTPUT');
      }
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new AiAdapterFault('INVALID_MODEL_OUTPUT');
      }
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new AiAdapterFault('INVALID_MODEL_OUTPUT');
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    configured,
    async answerQuestion(input: QuestionModelInput, callOptions: { signal: AbortSignal }): Promise<QuestionModelOutput> {
      try {
        return parseQuestionModelOutput(await complete(QA_SYSTEM_PROMPT, buildQuestionUserMessage(input), callOptions.signal));
      } catch (error) {
        if (error instanceof AiAdapterFault) throw new AppFault(error.code);
        throw new AppFault('INVALID_MODEL_OUTPUT');
      }
    },
    async createHint(input: HintModelInput, callOptions: { signal: AbortSignal }): Promise<HintModelOutput> {
      try {
        return parseHintModelOutput(await complete(HINT_SYSTEM_PROMPT, buildHintUserMessage(input), callOptions.signal));
      } catch (error) {
        if (error instanceof AiAdapterFault) throw new AppFault(error.code);
        throw new AppFault('INVALID_MODEL_OUTPUT');
      }
    },
  };
}

export function createOpenAiCompatibleAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenAiCompatibleOptions = {},
): AiAdapter {
  return createOpenAiCompatibleAdapter({
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    apiKey: env.AI_API_KEY,
    thinking: env.AI_THINKING,
  }, options);
}
