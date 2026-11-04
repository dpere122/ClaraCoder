/**
 * Settings for the generic OpenAI-compatible source. Servers agree on little beyond
 * ``POST /chat/completions``, so what they accept is configured here, usually by the connection test.
 */

import { parseAllowedHttpUrl } from './safe-http-url';

/** Field that carries the output cap. Newer OpenAI models reject ``max_tokens``; many servers ignore the other. */
export type OpenAiCompatTokensField = 'max_tokens' | 'max_completion_tokens';

/** Base URL for requests: the path the user gave, adding ``/v1`` only when there is none. Null if invalid. */
export function openAiCompatBaseUrl(raw: string): string | null {
  const parsed = parseAllowedHttpUrl(raw);
  if (!parsed) {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path || '/v1'}`;
}

/** How thinking is switched on this server; there is no standard. */
export type OpenAiCompatThinkingMethod = 'none' | 'reasoning_effort' | 'reasoning' | 'chat_template_kwargs';

export interface OpenAiCompatSettings {
  tokensField: OpenAiCompatTokensField;
  thinkingMethod: OpenAiCompatThinkingMethod;
  /** Some models only accept their default temperature and reject the field. */
  sendTemperature: boolean;
  /** Whether requests may carry ``parallel_tool_calls``. */
  sendParallelToolCalls: boolean;
  /** Ask for token usage with ``stream_options``; some servers reject the field. */
  streamUsage: boolean;
  /** Send ``top_k``, ``min_p`` and ``repeat_penalty``, which strict servers can reject. */
  nonStandardSampling: boolean;
  frequencyPenalty: number | null;
  seed: number | null;
  stop: string[];
  /** JSON object merged into every request, for anything without a control. */
  extraBody: string;
}

export const DEFAULT_OPENAI_COMPAT_SETTINGS: Readonly<OpenAiCompatSettings> = {
  tokensField: 'max_tokens',
  thinkingMethod: 'none',
  sendTemperature: true,
  sendParallelToolCalls: true,
  streamUsage: true,
  nonStandardSampling: false,
  frequencyPenalty: null,
  seed: null,
  stop: [],
  extraBody: '',
};

const TOKENS_FIELDS: readonly string[] = ['max_tokens', 'max_completion_tokens'];
const THINKING_METHODS: readonly string[] = ['none', 'reasoning_effort', 'reasoning', 'chat_template_kwargs'];

function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

export function normalizeOpenAiCompatSettings(raw: unknown): OpenAiCompatSettings {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_OPENAI_COMPAT_SETTINGS;
  const frequency = r['frequencyPenalty'];
  const seed = r['seed'];
  const tokensField = r['tokensField'];
  const thinkingMethod = r['thinkingMethod'];
  return {
    tokensField: TOKENS_FIELDS.includes(tokensField as string) ? (tokensField as OpenAiCompatTokensField) : d.tokensField,
    thinkingMethod: THINKING_METHODS.includes(thinkingMethod as string)
      ? (thinkingMethod as OpenAiCompatThinkingMethod)
      : d.thinkingMethod,
    sendTemperature: flag(r['sendTemperature'], d.sendTemperature),
    sendParallelToolCalls: flag(r['sendParallelToolCalls'], d.sendParallelToolCalls),
    streamUsage: flag(r['streamUsage'], d.streamUsage),
    nonStandardSampling: flag(r['nonStandardSampling'], d.nonStandardSampling),
    frequencyPenalty:
      typeof frequency === 'number' && Number.isFinite(frequency) ? Math.min(2, Math.max(-2, frequency)) : null,
    seed: typeof seed === 'number' && Number.isInteger(seed) ? seed : null,
    stop: Array.isArray(r['stop']) ? r['stop'].filter((s): s is string => typeof s === 'string' && s !== '').slice(0, 4) : [],
    extraBody: typeof r['extraBody'] === 'string' ? r['extraBody'] : '',
  };
}

/** The extra request body as an object, or why it can't be one. Empty text is an empty object. */
export function parseOpenAiCompatExtraBody(
  text: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, body: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON object, like {"key": "value"}.' };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not valid JSON.' };
  }
}

/** One row from ``GET /models``. ``contextLength`` is set only when the server reports it. */
export interface OpenAiCompatModel {
  id: string;
  contextLength?: number;
}

export type OpenAiCompatListResult = { ok: true; models: OpenAiCompatModel[] } | { ok: false; error: string };

/** Connection fields as typed in Settings, since a test runs before they are applied. */
export interface OpenAiCompatEndpoint {
  baseUrl: string;
  apiKey?: string;
  headers?: { key: string; value: string }[];
}

export type OpenAiCompatCheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface OpenAiCompatCheck {
  id: 'reachable' | 'models' | 'chat' | 'stream' | 'tools' | 'thinking';
  label: string;
  status: OpenAiCompatCheckStatus;
  detail: string;
}

export interface OpenAiCompatTestResult {
  checks: OpenAiCompatCheck[];
  /** Model the chat checks used; the selected one, or the first listed if none was. */
  testedModel: string;
  /** Settings the checks showed this server needs. Applied to the draft by Settings. */
  suggestions: Partial<
    Pick<OpenAiCompatSettings, 'tokensField' | 'thinkingMethod' | 'sendTemperature' | 'sendParallelToolCalls' | 'streamUsage'>
  >;
}
