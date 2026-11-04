/**
 * Talks to a generic OpenAI-compatible server for Settings: lists its models, and tests what it
 * actually accepts by sending real requests, reading the server's errors rather than assuming.
 */
import type {
  OpenAiCompatCheck,
  OpenAiCompatCheckStatus,
  OpenAiCompatEndpoint,
  OpenAiCompatListResult,
  OpenAiCompatModel,
  OpenAiCompatTestResult,
} from '../shared/openai-compat';
import { openAiCompatBaseUrl } from '../shared/openai-compat';

const LIST_TIMEOUT_MS = 15_000;
/** A local server may load the model on the first request. */
const CHAT_TIMEOUT_MS = 180_000;
/** Enough for a model that thinks first to still finish a short answer. */
const THINKING_ROOM_TOKENS = 512;
const ERROR_DETAIL_CHARS = 240;

const PING_TOOL = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Call this tool when asked to.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function openAiCompatUrl(baseUrl: string, path: string): string | null {
  const base = openAiCompatBaseUrl(baseUrl);
  return base ? `${base}/${path}` : null;
}

function requestHeaders(endpoint: OpenAiCompatEndpoint): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const key = (endpoint.apiKey ?? '').trim();
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  for (const { key: name, value } of endpoint.headers ?? []) {
    if (name.trim()) {
      headers[name.trim()] = value;
    }
  }
  return headers;
}

function fetchErrorMessage(e: unknown): string {
  if (!(e instanceof Error)) {
    return String(e);
  }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return 'The server did not respond in time.';
  }
  const cause = e.cause instanceof Error ? e.cause.message : '';
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message;
}

/** The server's own error text when it sends JSON, else the body. */
function errorText(status: number, body: string): string {
  const text = body.trim();
  let message = text;
  try {
    const root = asRecord(JSON.parse(text));
    const err = root?.['error'];
    const nested = asRecord(err)?.['message'] ?? root?.['message'] ?? root?.['detail'];
    if (typeof err === 'string') {
      message = err;
    } else if (typeof nested === 'string') {
      message = nested;
    }
  } catch {
    // Not JSON: use the body as it is.
  }
  return `HTTP ${status}${message ? `: ${message.slice(0, ERROR_DETAIL_CHARS)}` : ''}`;
}

/** Context length under the names servers use for it (OpenRouter, vLLM, LM Studio, llama-server). */
function reportedContextLength(row: Record<string, unknown>): number | undefined {
  const meta = asRecord(row['meta']);
  for (const raw of [row['context_length'], row['max_model_len'], row['max_context_length'], row['context_window'], meta?.['n_ctx_train']]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
  }
  return undefined;
}

function modelsFromBody(body: unknown): OpenAiCompatModel[] {
  const root = asRecord(body);
  const rows = Array.isArray(root?.['data']) ? root['data'] : Array.isArray(root?.['models']) ? root['models'] : [];
  const models: OpenAiCompatModel[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    const id = row?.['id'] ?? row?.['name'];
    if (row && typeof id === 'string' && id.trim()) {
      const contextLength = reportedContextLength(row);
      models.push({ id: id.trim(), ...(contextLength ? { contextLength } : {}) });
    }
  }
  return models;
}

export async function openAiCompatListModels(endpoint: OpenAiCompatEndpoint): Promise<OpenAiCompatListResult> {
  const url = openAiCompatUrl(endpoint.baseUrl, 'models');
  if (!url) {
    return { ok: false, error: 'Enter a valid http or https URL.' };
  }
  try {
    const res = await fetch(url, { headers: requestHeaders(endpoint), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) {
      return { ok: false, error: errorText(res.status, await res.text().catch(() => '')) };
    }
    return { ok: true, models: modelsFromBody(await res.json().catch(() => null)) };
  } catch (e) {
    return { ok: false, error: fetchErrorMessage(e) };
  }
}

type ChatOutcome =
  | { kind: 'ok'; message: Record<string, unknown>; usage: Record<string, unknown> | null }
  | { kind: 'rejected'; status: number; error: string }
  | { kind: 'failed'; error: string };

async function postChat(endpoint: OpenAiCompatEndpoint, url: string, body: Record<string, unknown>): Promise<ChatOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(endpoint),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { kind: 'rejected', status: res.status, error: errorText(res.status, await res.text().catch(() => '')) };
    }
    const root = asRecord(await res.json().catch(() => null));
    const choices = root?.['choices'];
    const message = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.['message']) : null;
    if (!message) {
      return { kind: 'failed', error: 'The reply was not a chat completion.' };
    }
    return { kind: 'ok', message, usage: asRecord(root?.['usage']) };
  } catch (e) {
    return { kind: 'failed', error: fetchErrorMessage(e) };
  }
}

/** Reads a streamed reply to the end. ``chunks`` counts data events that carried a choice. */
async function postStream(
  endpoint: OpenAiCompatEndpoint,
  url: string,
  body: Record<string, unknown>,
): Promise<{ kind: 'ok'; chunks: number; usage: boolean } | { kind: 'rejected'; status: number; error: string } | { kind: 'failed'; error: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(endpoint),
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { kind: 'rejected', status: res.status, error: errorText(res.status, await res.text().catch(() => '')) };
    }
    const text = await res.text();
    let chunks = 0;
    let usage = false;
    for (const line of text.split('\n')) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') {
        continue;
      }
      const event = (() => {
        try {
          return asRecord(JSON.parse(data));
        } catch {
          return null;
        }
      })();
      if (Array.isArray(event?.['choices']) && event['choices'].length) {
        chunks += 1;
      }
      if (asRecord(event?.['usage'])) {
        usage = true;
      }
    }
    return { kind: 'ok', chunks, usage };
  } catch (e) {
    return { kind: 'failed', error: fetchErrorMessage(e) };
  }
}

/** True when a rejection is about this field, so a retry without it can tell. */
function mentions(error: string, field: string): boolean {
  return error.toLowerCase().includes(field.toLowerCase());
}

function reasoningTokens(usage: Record<string, unknown> | null): number {
  const n = asRecord(usage?.['completion_tokens_details'])?.['reasoning_tokens'];
  return typeof n === 'number' ? n : 0;
}

/** Whether a reply shows the model thought: reasoning text, or a reasoning token count. */
function showedThinking(outcome: Extract<ChatOutcome, { kind: 'ok' }>): boolean {
  const { message, usage } = outcome;
  return !!(message['reasoning_content'] || message['reasoning']) || reasoningTokens(usage) > 0;
}

/**
 * Runs the checks in order; each uses what the earlier ones learned. Stops early only when going
 * on could not tell the user anything new, since on a paid service every request costs a little.
 */
export async function runOpenAiCompatTest(endpoint: OpenAiCompatEndpoint, selectedModel: string): Promise<OpenAiCompatTestResult> {
  const checks: OpenAiCompatCheck[] = [];
  const result: OpenAiCompatTestResult = { checks, testedModel: '', suggestions: {} };
  const add = (id: OpenAiCompatCheck['id'], label: string, status: OpenAiCompatCheckStatus, detail: string): void => {
    checks.push({ id, label, status, detail });
  };
  const skipRest = (from: readonly [OpenAiCompatCheck['id'], string][], why: string): OpenAiCompatTestResult => {
    for (const [id, label] of from) {
      add(id, label, 'skipped', why);
    }
    return result;
  };
  const CHAT: [OpenAiCompatCheck['id'], string] = ['chat', 'Chat'];
  const STREAM: [OpenAiCompatCheck['id'], string] = ['stream', 'Streaming and token usage'];
  const TOOLS: [OpenAiCompatCheck['id'], string] = ['tools', 'Tool calling'];
  const THINKING: [OpenAiCompatCheck['id'], string] = ['thinking', 'Thinking'];
  const AFTER_MODELS = [CHAT, STREAM, TOOLS, THINKING] as const;

  const chatUrl = openAiCompatUrl(endpoint.baseUrl, 'chat/completions');
  const modelsUrl = openAiCompatUrl(endpoint.baseUrl, 'models');
  if (!chatUrl || !modelsUrl) {
    add('reachable', 'Server and API key', 'fail', 'Enter a valid http or https URL.');
    return skipRest([['models', 'Model list'], ...AFTER_MODELS], 'Needs a reachable server.');
  }

  let listed: OpenAiCompatModel[] = [];
  try {
    const res = await fetch(modelsUrl, { headers: requestHeaders(endpoint), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) {
      add('reachable', 'Server and API key', 'fail', `The server rejected the API key (HTTP ${res.status}).`);
      return skipRest([['models', 'Model list'], ...AFTER_MODELS], 'Needs an accepted API key.');
    }
    add('reachable', 'Server and API key', 'ok', `The server answered at ${new URL(modelsUrl).origin}.`);
    if (res.ok) {
      listed = modelsFromBody(await res.json().catch(() => null));
      add('models', 'Model list', listed.length ? 'ok' : 'warn', listed.length ? `${listed.length} models listed.` : 'The list came back empty. Type a model ID instead.');
    } else {
      add('models', 'Model list', 'warn', `No list here (HTTP ${res.status}). Type a model ID instead.`);
    }
  } catch (e) {
    add('reachable', 'Server and API key', 'fail', fetchErrorMessage(e));
    return skipRest([['models', 'Model list'], ...AFTER_MODELS], 'Needs a reachable server.');
  }

  const model = selectedModel.trim() || listed[0]?.id || '';
  result.testedModel = model;
  if (!model) {
    return skipRest(AFTER_MODELS, 'Choose a model first.');
  }

  // Chat: learn which output field and whether temperature is accepted, from the server's errors.
  const base: Record<string, unknown> = { model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] };
  let tokensField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  let useTemperature = true;
  const chatBody = (): Record<string, unknown> => ({
    ...base,
    [tokensField]: THINKING_ROOM_TOKENS,
    ...(useTemperature ? { temperature: 0.2 } : {}),
  });
  let chat = await postChat(endpoint, chatUrl, chatBody());
  for (let attempt = 0; attempt < 2 && chat.kind === 'rejected' && chat.status === 400; attempt += 1) {
    if (tokensField === 'max_tokens' && mentions(chat.error, 'max_tokens')) {
      tokensField = 'max_completion_tokens';
    } else if (useTemperature && mentions(chat.error, 'temperature')) {
      useTemperature = false;
    } else {
      break;
    }
    chat = await postChat(endpoint, chatUrl, chatBody());
  }
  if (chat.kind !== 'ok') {
    add('chat', 'Chat', 'fail', chat.error);
    return skipRest([STREAM, TOOLS, THINKING], 'Needs a working chat request.');
  }
  result.suggestions.tokensField = tokensField;
  result.suggestions.sendTemperature = useTemperature;
  const adjustments = [
    tokensField === 'max_completion_tokens' ? 'needs max_completion_tokens' : '',
    useTemperature ? '' : 'rejects temperature',
  ].filter(Boolean);
  add('chat', 'Chat', 'ok', adjustments.length ? `Works. The server ${adjustments.join(' and ')}.` : `${model} replied.`);

  // Streaming, with and then without the usage option.
  let stream = await postStream(endpoint, chatUrl, { ...chatBody(), stream_options: { include_usage: true } });
  let usageOption = true;
  if (stream.kind === 'rejected' && stream.status === 400) {
    usageOption = false;
    stream = await postStream(endpoint, chatUrl, chatBody());
  }
  if (stream.kind !== 'ok') {
    add('stream', 'Streaming and token usage', 'fail', `${stream.error} Clara streams every reply, so chat won't work.`);
  } else {
    result.suggestions.streamUsage = usageOption;
    if (!stream.chunks) {
      add('stream', 'Streaming and token usage', 'fail', "The server didn't stream a reply. Clara streams every reply, so chat won't work.");
    } else if (stream.usage) {
      add('stream', 'Streaming and token usage', 'ok', 'Streams, and reports token usage.');
    } else {
      add('stream', 'Streaming and token usage', 'warn', "Streams, but reports no token usage, so Clara has to estimate how full the context is.");
    }
  }

  // Tools: the agent depends on them.
  const toolBody = (parallel: boolean): Record<string, unknown> => ({
    ...chatBody(),
    messages: [{ role: 'user', content: 'Call the ping tool now.' }],
    tools: [PING_TOOL],
    ...(parallel ? { parallel_tool_calls: true } : {}),
  });
  let tool = await postChat(endpoint, chatUrl, toolBody(true));
  let parallelField = true;
  if (tool.kind === 'rejected' && tool.status === 400 && mentions(tool.error, 'parallel_tool_calls')) {
    parallelField = false;
    tool = await postChat(endpoint, chatUrl, toolBody(false));
  }
  if (tool.kind !== 'ok') {
    add('tools', 'Tool calling', 'fail', `${tool.error} Clara's agent relies on tool calls.`);
  } else {
    result.suggestions.sendParallelToolCalls = parallelField;
    const calls = tool.message['tool_calls'];
    if (Array.isArray(calls) && calls.length) {
      add('tools', 'Tool calling', 'ok', parallelField ? 'The model called the test tool.' : 'The model called the test tool. The server rejects parallel_tool_calls.');
    } else {
      add('tools', 'Tool calling', 'warn', "The request was accepted, but the model didn't call the test tool. Clara's agent relies on tool calls.");
    }
  }

  // Thinking: only worth requests if this model visibly thinks.
  if (!showedThinking(chat) && !(tool.kind === 'ok' && showedThinking(tool))) {
    result.suggestions.thinkingMethod = 'none';
    add('thinking', 'Thinking', 'skipped', "This model didn't show any thinking, so there's nothing to control.");
    return result;
  }
  const offSwitches: [typeof result.suggestions.thinkingMethod, string, Record<string, unknown>][] = [
    ['reasoning_effort', 'reasoning_effort', { reasoning_effort: 'none' }],
    ['reasoning', 'reasoning', { reasoning: { effort: 'none' } }],
    ['chat_template_kwargs', 'chat_template_kwargs', { chat_template_kwargs: { enable_thinking: false } }],
  ];
  for (const [method, label, fields] of offSwitches) {
    const attempt = await postChat(endpoint, chatUrl, { ...chatBody(), ...fields });
    if (attempt.kind === 'ok' && !showedThinking(attempt)) {
      result.suggestions.thinkingMethod = method;
      add('thinking', 'Thinking', 'ok', `This model thinks, and ${label} turns it off.`);
      return result;
    }
  }
  result.suggestions.thinkingMethod = 'none';
  add('thinking', 'Thinking', 'warn', 'This model thinks, but none of the known settings turned it off.');
  return result;
}
