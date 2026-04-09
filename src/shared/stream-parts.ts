import type { StreamPart } from './types/conversation';
import type { LlmAgentRole } from './types/llm';

/** Concatenate every part in order (legacy single-bubble join). */
export function joinAllStreamPartTexts(parts: StreamPart[]): string {
  return parts.map((p) => p.text).join('');
}

/** Collapse newlines and runs of whitespace for in-flight stream display only (saved reply unchanged). */
export function streamPlainOneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Outer Clara model stream (`agent`). `mgr` included for legacy saved streams only. */
export function isPrimaryAssistantStreamTag(streamTag: string): boolean {
  const t = streamTag.trim();
  return t === 'agent' || t === 'mgr';
}

/** Multiplexed nested handoffs surfaced as status rows for outer Clara (planner plan, review outcomes). */
export const CLARA_OUTER_BRIEF_STREAM_TAG = 'clara';

export function isClaraOuterBriefStreamTag(streamTag: string | undefined): boolean {
  return (streamTag ?? '').trim() === CLARA_OUTER_BRIEF_STREAM_TAG;
}

/**
 * Nested pipeline: coding planner (`planner`), planning router (`planning`), and `spec-*` subgraphs.
 */
export function streamIndicatesNestedSpecialistRouting(parts: StreamPart[]): boolean {
  return parts.some((p) => {
    const t = p.streamTag.trim();
    return t === 'planner' || t === 'planning' || t.startsWith('spec-');
  });
}

/** Primary (main) live stream: outer `agent` chunks (and legacy `mgr`). */
export function primaryStreamPartsForDisplay(
  parts: StreamPart[],
  _processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return parts.filter((p) => isPrimaryAssistantStreamTag(p.streamTag));
}

/** Subprocess and legacy side streams: planning, specialists, legacy `worker`, etc. */
export function delegatedStreamPartsForDisplay(
  parts: StreamPart[],
  _processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return parts.filter((p) => !isPrimaryAssistantStreamTag(p.streamTag));
}

/**
 * Fixed stream tags that always use the delegated terminal shell.
 * Extend this when adding new `tool_exec_chunk` tools that are not named with `-tests` / `-smoke`.
 */
export const SHELL_STYLE_TOOL_STREAM_TAGS: ReadonlySet<string> = new Set<string>([
  // e.g. 'spec-project_review-custom_run'
]);

/**
 * Stream tags whose multiplexed output should use the Run-style terminal shell in chat
 * (workspace pytest, smoke tests, etc.).
 *
 * Matches {@link SHELL_STYLE_TOOL_STREAM_TAGS} or tags ending with `-tests` / `-smoke`.
 */
export function isShellStyleToolStreamTag(streamTag: string): boolean {
  const t = streamTag.trim();
  if (SHELL_STYLE_TOOL_STREAM_TAGS.has(t)) {
    return true;
  }
  return t.endsWith('-tests') || t.endsWith('-smoke');
}

/**
 * Text to persist and pass to TTS: `agent` first, then legacy `mgr`/`worker`.
 * Nested `planner` / `planning` / `spec-*` chunks are never persisted (outer agent should stream the user-facing reply).
 */
export function primaryAssistantTextFromParts(parts: StreamPart[], _processingAgentRoleAtEnd: LlmAgentRole | null = null): string {
  const agent = parts
    .filter((p) => p.streamTag.trim() === 'agent')
    .map((p) => p.text)
    .join('');
  if (agent.length > 0) {
    return agent;
  }

  const mgr = parts
    .filter((p) => p.streamTag.trim() === 'mgr')
    .map((p) => p.text)
    .join('');
  if (mgr.length > 0) {
    return mgr;
  }

  const worker = parts
    .filter((p) => p.streamTag.trim() === 'worker')
    .map((p) => p.text)
    .join('');
  if (worker.length > 0) {
    return worker;
  }
  return '';
}

/**
 * Ignore whitespace-only model chunks while a workspace tool is actively running
 * (avoids blank lines accumulating in the live bubble before tool I/O).
 */
export function shouldIgnoreWhitespaceOnlyModelChunkDuringTool(
  delta: string,
  toolRunInProgress: boolean,
): boolean {
  return toolRunInProgress && delta.trim() === '';
}
