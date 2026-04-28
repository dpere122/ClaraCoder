import type { LlmOptimizationPreset } from './types/app-config';
import { isGemmaFamily } from './model-context';

/**
 * Gemma / LM Studio pipe tags: ``<|channel|>``, ``<|channel>``, ``<|anything|>`` … up to first ``>``.
 * (GGUF logs use both ``|>`` and plain ``>`` closings.)
 */
const GEMMA_PIPE_TAG_RE = /<\|[^>\r\n]+>/g;
const TURN_TOKEN_RE = /<turn\|>/g;
/** Prose/XML tool channel leaks (models sometimes paste this into ``content`` instead of using API tools). */
const PSEUDO_TOOL_CALL_BLOCK_RE = /<tool_call\b[\s\S]*?<\/tool_call>/gi;
const PSEUDO_TOOL_CALL_OPEN_RE = /<tool_call\b[^>]*\/>/gi;
/** Leading “thinking process” heading models often emit after ``<|channel>`` (Chinese UI). */
const LEADING_THINKING_HEADING_RE = /^(?:\r?\n|\s)*思考过程[:：]\s*(?:\r?\n)+/u;
/** English self-correction parenthetical the model leaves before the real answer. */
const SELF_CORRECTION_PAREN_RE = /\(Self-Correction:[^)]*\)/gi;

/** True when we should strip Gemma / LM Studio chat-template markers from visible assistant text. */
export function gemmaTemplateSanitizeActive(options: {
  optimizationPreset?: LlmOptimizationPreset | string | null | undefined;
  model?: string | null | undefined;
}): boolean {
  const p = String(options.optimizationPreset ?? '')
    .trim()
    .toLowerCase();
  if (p === 'gemma') {
    return true;
  }
  return isGemmaFamily(options.model ?? '');
}

/** Remove ``<tool_call>...</tool_call>`` and self-closing variants (global; rare in fenced examples). */
export function stripPseudoToolCallXml(text: string): string {
  let s = text;
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(PSEUDO_TOOL_CALL_BLOCK_RE, '');
  }
  s = s.replace(PSEUDO_TOOL_CALL_OPEN_RE, '');
  return s;
}

/** Control markers + pseudo tool-call XML; use for persisted assistant text and markdown render. */
export function stripAssistantChannelNoise(text: string): string {
  let t = stripLlmControlMarkers(stripPseudoToolCallXml(text));
  t = t.replace(LEADING_THINKING_HEADING_RE, '');
  t = t.replace(SELF_CORRECTION_PAREN_RE, '');
  if (isPlaceholderThinkingNoise(t)) {
    return '';
  }
  return t;
}

/**
 * Remove Gemma ``<|…>`` / ``<|…|>`` tags and ``<turn|>`` outside fenced code blocks (same fence heuristic as
 * markdown-normalize) so literals in code strings are preserved.
 */
export function stripLlmControlMarkers(text: string): string {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const out: string[] = [];

  for (const line of lines) {
    if (inFence) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = true;
      out.push(line);
      continue;
    }

    let processed = line;
    let prev = '';
    while (prev !== processed) {
      prev = processed;
      processed = processed.replace(GEMMA_PIPE_TAG_RE, '');
    }
    processed = processed.replace(TURN_TOKEN_RE, '');
    out.push(processed);
  }

  return out.join('\n');
}

/** Single-character walls models sometimes stream into thinking / side channels. */
const DOMINANT_FILLER_CHARS = new Set<string>([
  '/',
  '.',
  '-',
  '_',
  '#',
  '=',
  '*',
  '+',
  '`',
  '~',
  '|',
  '\\',
]);

function dominantFillerNoise(collapsed: string, minChars: number, minRatio: number): boolean {
  if (collapsed.length < minChars) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const c of collapsed) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let max = 0;
  let maxChar = '';
  for (const [c, n] of counts) {
    if (n > max) {
      max = n;
      maxChar = c;
    }
  }
  if (max / collapsed.length < minRatio || !DOMINANT_FILLER_CHARS.has(maxChar)) {
    return false;
  }
  return true;
}

/** True when *text* is mostly tokenizer / redaction placeholders (ASCII `?`, U+FFFD, U+FF1F). */
export function isPlaceholderThinkingNoise(text: string, minChars = 32, minRatio = 0.88): boolean {
  const collapsed = (text ?? '').replace(/\s+/g, '');
  if (collapsed.length < minChars) {
    return false;
  }
  let bad = 0;
  for (const c of collapsed) {
    if (c === '?' || c === '\uFFFD' || c === '\uFF1F') {
      bad++;
    }
  }
  if (bad / collapsed.length >= minRatio) {
    return true;
  }
  return dominantFillerNoise(collapsed, minChars, minRatio);
}

/** Collapse 4+ consecutive newlines to three (reduces ladders after stripping markers). */
export function collapseExcessiveAssistantBlankLines(text: string): string {
  return text.replace(/(?:\r?\n){4,}/g, '\n\n\n');
}

/** Strip template noise then normalize blank runs (use only when `gemmaTemplateSanitizeActive` is true). */
export function sanitizeGemmaVisibleAssistantText(text: string): string {
  return collapseExcessiveAssistantBlankLines(stripAssistantChannelNoise(text));
}
