/**
 * Cheap Jinja chat-template scan for thinking / reasoning knobs.
 * Does not compile or execute Jinja — only identifier and allow-list regexes.
 */

/** Live llama-server template capabilities (not persisted in AppConfig). */
export interface ChatTemplateReasoningCaps {
  enableThinking: boolean;
  /**
   * ``null`` when the template does not expose ``reasoning_effort``.
   * Non-null is the allowed effort tokens (no empty Default; UI prepends that).
   */
  reasoningEffortValues: readonly string[] | null;
}

/** API effort tokens recognized in Jinja allow-lists (not UI aliases on/off). */
export const GENERIC_REASONING_EFFORT_VALUES: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

/**
 * Official Qwen 3.8 ``not in ('xhigh', 'medium', 'low')`` allow-list.
 * Used as the Qwen-preset fallback when a live scan has not run yet.
 */
export const QWEN_REASONING_EFFORT_VALUES: readonly string[] = ['low', 'medium', 'xhigh'];

const KNOWN_EFFORT = new Set<string>(GENERIC_REASONING_EFFORT_VALUES);

/** `{% %}` / `{{ }}` including whitespace-control `{%-` / `-%}`. */
const JINJA_CHUNK_RE = /\{%-?[\s\S]*?-?%\}|\{\{[\s\S]*?\}\}/g;

/**
 * Allow-list immediately after ``reasoning_effort`` / ``resolved_reasoning_effort``.
 * Qwen3.8 uses a tuple ``('xhigh', 'medium', 'low')``; older templates use ``["xhigh", …]``.
 */
const EFFORT_LIST_NEAR_RE =
  /\breasoning_effort\b[\s\S]{0,280}?(?:not\s+)?in\s*[\[(]([^\]\)]*)[\])]/i;
const EFFORT_BRACKET_NEAR_RE = /\breasoning_effort\b[\s\S]{0,240}?\[([^\]]*)\]/;
const QUOTED_TOKEN_RE = /['"]([^'"]+)['"]/g;

function jinjaBlob(template: string): string {
  const chunks = template.match(JINJA_CHUNK_RE);
  return chunks ? chunks.join('\n') : '';
}

function tokensFromListBody(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  QUOTED_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED_TOKEN_RE.exec(body)) !== null) {
    const token = m[1].trim().toLowerCase();
    if (!KNOWN_EFFORT.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    found.push(token);
  }
  return found;
}

function extractEffortAllowList(blob: string): readonly string[] | null {
  if (!/\breasoning_effort\b/.test(blob)) {
    return null;
  }
  const listMatch = EFFORT_LIST_NEAR_RE.exec(blob) ?? EFFORT_BRACKET_NEAR_RE.exec(blob);
  if (!listMatch) {
    return GENERIC_REASONING_EFFORT_VALUES;
  }
  const found = tokensFromListBody(listMatch[1]);
  return found.length > 0 ? found : GENERIC_REASONING_EFFORT_VALUES;
}

/** Parse a GGUF / llama-server Jinja chat template for thinking and effort knobs. */
export function parseChatTemplateReasoning(template: string): ChatTemplateReasoningCaps {
  const blob = jinjaBlob(template || '');
  return {
    enableThinking: /\benable_thinking\b/.test(blob),
    reasoningEffortValues: extractEffortAllowList(blob),
  };
}

function llamaCapsSupportReasoningEffort(caps: unknown): boolean {
  if (!caps || typeof caps !== 'object') {
    return false;
  }
  return (caps as { supports_reasoning_effort?: unknown }).supports_reasoning_effort === true;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Read reasoning caps from a llama-server ``GET /props`` JSON body.
 * Merges ``chat_template_caps.supports_reasoning_effort`` when the regex missed effort.
 */
export function parseLlamaServerPropsReasoning(body: unknown): {
  caps: ChatTemplateReasoningCaps;
  templateBytes: number;
  missingTemplate: boolean;
} {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawTemplate = obj['chat_template'];
  const template = typeof rawTemplate === 'string' ? rawTemplate : '';
  const missingTemplate = !template;
  const parsed = parseChatTemplateReasoning(template);
  let effort = parsed.reasoningEffortValues;
  if (effort == null && llamaCapsSupportReasoningEffort(obj['chat_template_caps'])) {
    effort = GENERIC_REASONING_EFFORT_VALUES;
  }
  return {
    caps: { enableThinking: parsed.enableThinking, reasoningEffortValues: effort },
    templateBytes: utf8ByteLength(template),
    missingTemplate,
  };
}

/** Compact Health-log summary (never dumps the Jinja body). */
export function formatChatTemplateReasoningSummary(caps: ChatTemplateReasoningCaps): string {
  const effort =
    caps.reasoningEffortValues == null ? 'none' : caps.reasoningEffortValues.join(',') || 'none';
  return `enableThinking=${caps.enableThinking} reasoningEffort=${effort}`;
}
