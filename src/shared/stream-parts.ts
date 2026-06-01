import type { StreamPart } from './types/conversation';
import type { LlmAgentRole } from './types/llm';

/** Concatenate every part in order (legacy single-bubble join). */
export function joinAllStreamPartTexts(parts: StreamPart[]): string {
  return parts.map((p) => p.text).join('');
}

/** Join primary (`agent`) stream parts for live display — preserves newlines (no one-line collapse). */
export function joinPrimaryAssistantStreamText(parts: StreamPart[]): string {
  return primaryStreamPartsForDisplay(parts, null)
    .map((p) => p.text)
    .join('');
}

/** Collapse newlines and runs of whitespace for in-flight stream display only (saved reply unchanged). */
export function streamPlainOneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Outer Clara primary reply lane. */
export function isPrimaryAssistantStreamTag(streamTag: string): boolean {
  return streamTag.trim() === 'agent';
}

/** Multiplexed nested handoffs surfaced as status rows for outer Clara. */
export const CLARA_OUTER_BRIEF_STREAM_TAG = 'clara';

export function isClaraOuterBriefStreamTag(streamTag: string | undefined): boolean {
  return (streamTag ?? '').trim() === CLARA_OUTER_BRIEF_STREAM_TAG;
}

/** Canonical SSE `stream_tag` for auxiliary model output (e.g. reasoning_content). */
export const REASONING_AUXILIARY_STREAM_TAG = 'reasoning';

/** Pre-rename wire tag (`moe`); still accepted when loading saved conversations. */
const LEGACY_REASONING_STREAM_TAG = 'moe';

export function isReasoningAuxiliaryStreamTag(streamTag: string): boolean {
  const t = streamTag.trim();
  return t === REASONING_AUXILIARY_STREAM_TAG || t === LEGACY_REASONING_STREAM_TAG;
}

/** Normalize legacy reasoning tags to {@link REASONING_AUXILIARY_STREAM_TAG} before persisting. */
export function normalizeReasoningStreamPart(part: StreamPart): StreamPart {
  if (part.streamTag.trim() !== LEGACY_REASONING_STREAM_TAG) {
    return part;
  }
  return { ...part, streamTag: REASONING_AUXILIARY_STREAM_TAG };
}

/**
 * Legacy multiplex tag for read-tool preview chunks (merged into the matching `tool-trail:*` row).
 * New streams append preview text directly on the read tool status part.
 */
export const READ_TOOL_PREVIEW_STREAM_TAG = 'tool-read-preview';

/** Tool names whose streamed preview is folded into the matching tool-trail status row. */
export const WORKSPACE_READ_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'list_workspace_directory',
  'retrieve_workspace_semantic',
  'search_workspace',
  'read_workspace_file',
  'read_workspace_image',
  'read_staged_edit',
]);

export function isReadToolPreviewStreamTag(streamTag: string): boolean {
  return streamTag.trim() === READ_TOOL_PREVIEW_STREAM_TAG;
}

export function isWorkspaceReadToolLabel(label: string): boolean {
  return WORKSPACE_READ_TOOL_NAMES.has(label.trim());
}

/** Staging overlay subprocess output (code review). */
export const TOOL_OVERLAY_STREAM_TAG = 'tool-overlay';

/** Workspace pytest subprocess terminal lane. */
export const TOOL_PYTEST_STREAM_TAG = 'tool-pytest';

/** Workspace Python smoke-test subprocess lane. */
export const TOOL_SMOKE_STREAM_TAG = 'tool-smoke';

/** Workspace Node smoke-test subprocess lane. */
export const TOOL_NODE_SMOKE_STREAM_TAG = 'tool-node-smoke';

/** Plan-and-execute planner lane (status rows + progress payloads). */
export const PLANNER_STREAM_TAG = 'planner';

const REMOVED_STREAM_TAGS = new Set(['planning', 'mgr', 'worker']);

const LEGACY_SPEC_TAG_MAP: Readonly<Record<string, string>> = {
  'spec-read-preview': READ_TOOL_PREVIEW_STREAM_TAG,
  'spec-code_review-overlay': TOOL_OVERLAY_STREAM_TAG,
  'spec-project_review-tests': TOOL_PYTEST_STREAM_TAG,
  'spec-project_review-smoke': TOOL_SMOKE_STREAM_TAG,
  'spec-project_review-node-smoke': TOOL_NODE_SMOKE_STREAM_TAG,
};

/**
 * Map a wire or saved `streamTag` to a canonical tag, or `null` to omit (removed legacy lanes).
 */
export function normalizeStreamTag(streamTag: string): string | null {
  const t = streamTag.trim();
  if (!t || REMOVED_STREAM_TAGS.has(t)) {
    return null;
  }
  const mapped = LEGACY_SPEC_TAG_MAP[t];
  if (mapped) {
    return mapped;
  }
  if (t.startsWith('spec-')) {
    if (t.endsWith('-node-smoke')) {
      return TOOL_NODE_SMOKE_STREAM_TAG;
    }
    if (t.endsWith('-tests')) {
      return TOOL_PYTEST_STREAM_TAG;
    }
    if (t.endsWith('-smoke')) {
      return TOOL_SMOKE_STREAM_TAG;
    }
    if (t.includes('overlay')) {
      return TOOL_OVERLAY_STREAM_TAG;
    }
    if (t.includes('read')) {
      return READ_TOOL_PREVIEW_STREAM_TAG;
    }
    return null;
  }
  return t;
}

/** Normalize tag and drop removed legacy parts. */
export function normalizeStreamPart(part: StreamPart): StreamPart | null {
  const tag = normalizeStreamTag(part.streamTag);
  if (tag === null) {
    return null;
  }
  const reasoning =
    part.streamTag.trim() === LEGACY_REASONING_STREAM_TAG
      ? { ...part, streamTag: REASONING_AUXILIARY_STREAM_TAG }
      : part;
  if (reasoning.streamTag.trim() === tag) {
    return reasoning;
  }
  return { ...reasoning, streamTag: tag };
}

/** Prefix for synthetic stream tags that mirror `LlmStatus` rows with `source: tool` into the auxiliary timeline. */
export const TOOL_TRAIL_STATUS_STREAM_PREFIX = 'tool-trail:';

/** Stable multiplex tag for one tool status row (interleaved with reasoning / tool output). */
export function toolTrailStatusStreamTag(statusId: string): string {
  return `${TOOL_TRAIL_STATUS_STREAM_PREFIX}${encodeURIComponent(statusId)}`;
}

export function isToolTrailStatusStreamTag(streamTag: string): boolean {
  return streamTag.trim().startsWith(TOOL_TRAIL_STATUS_STREAM_PREFIX);
}

/** Decode the backend status `id` embedded in a `tool-trail:*` multiplex tag. */
export function toolTrailStatusIdFromStreamTag(streamTag: string): string | null {
  const tag = streamTag.trim();
  if (!tag.startsWith(TOOL_TRAIL_STATUS_STREAM_PREFIX)) {
    return null;
  }
  const encoded = tag.slice(TOOL_TRAIL_STATUS_STREAM_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** Index of the tool-trail row that should receive read preview text, or -1. */
export function findReadToolTrailTargetIndex(parts: readonly StreamPart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (isToolTrailStatusStreamTag(part.streamTag) && isWorkspaceReadToolLabel(part.label)) {
      return i;
    }
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isToolTrailStatusStreamTag(parts[i].streamTag)) {
      return i;
    }
  }
  return -1;
}

/** Fold legacy `tool-read-preview` parts into the preceding read tool-trail row. */
export function mergeReadPreviewIntoToolTrailParts(parts: StreamPart[]): StreamPart[] {
  const out: StreamPart[] = [];
  for (const raw of parts) {
    const normalized = normalizeStreamPart(raw);
    if (!normalized) {
      continue;
    }
    if (isReadToolPreviewStreamTag(normalized.streamTag)) {
      const target = findReadToolTrailTargetIndex(out);
      if (target >= 0) {
        const prev = out[target]!;
        out[target] = { ...prev, text: prev.text + normalized.text };
        continue;
      }
    }
    out.push(normalized);
  }
  return out;
}

/** Append a `tool_read_chunk` delta onto the active read tool-trail row (single combined UI). */
export function appendReadToolPreviewChunk(parts: StreamPart[], delta: string): StreamPart[] {
  const idx = findReadToolTrailTargetIndex(parts);
  if (idx < 0) {
    return appendStreamPartWithTag(parts, READ_TOOL_PREVIEW_STREAM_TAG, delta, '');
  }
  const next = parts.map((p) => ({ ...p }));
  const row = next[idx]!;
  next[idx] = { ...row, text: row.text + delta };
  return next;
}

/** Append read preview deltas and fold any orphan `tool-read-preview` lane into the tool-trail row. */
export function appendAndMergeReadToolPreviewChunk(parts: StreamPart[], delta: string): StreamPart[] {
  return mergeReadPreviewIntoToolTrailParts(appendReadToolPreviewChunk(parts, delta));
}

function appendStreamPartWithTag(
  parts: StreamPart[],
  t: string,
  delta: string,
  label: string,
): StreamPart[] {
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.streamTag === t) {
    next[next.length - 1] = { ...last, label: last.label || label, text: last.text + delta };
    return next;
  }
  next.push({ streamTag: t, label, text: delta });
  return next;
}

/** True when the saved or live auxiliary timeline already includes embedded tool-status segments. */
export function auxiliaryTimelineEmbedsToolStatus(parts: readonly StreamPart[]): boolean {
  return parts.some((p) => isToolTrailStatusStreamTag(p.streamTag));
}

/** In-flight reasoning segments (same shape as tool multiplexing, distinct tag). */
export function reasoningStreamPartsForDisplay(
  parts: StreamPart[],
  _processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return parts.filter((p) => isReasoningAuxiliaryStreamTag(p.streamTag));
}

/**
 * Stream tags whose multiplexed output uses the Run-style terminal shell in chat
 * (workspace pytest, smoke tests, etc.).
 */
export const SHELL_STYLE_TOOL_STREAM_TAGS: ReadonlySet<string> = new Set<string>([
  TOOL_PYTEST_STREAM_TAG,
  TOOL_SMOKE_STREAM_TAG,
  TOOL_NODE_SMOKE_STREAM_TAG,
]);

export function isShellStyleToolStreamTag(streamTag: string): boolean {
  return SHELL_STYLE_TOOL_STREAM_TAGS.has(streamTag.trim());
}

/** Delegated streams rendered in the shell-style terminal (pytest, smoke, etc.). */
export function shellDelegatedStreamPartsForDisplay(
  parts: StreamPart[],
  processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return delegatedStreamPartsForDisplay(parts, processingAgentRole).filter((p) =>
    isShellStyleToolStreamTag(p.streamTag),
  );
}

/** Non-shell tool output (overlay, read preview, etc.). */
export function otherDelegatedStreamPartsForDisplay(
  parts: StreamPart[],
  processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return delegatedStreamPartsForDisplay(parts, processingAgentRole).filter(
    (p) =>
      !isShellStyleToolStreamTag(p.streamTag) &&
      !isReasoningAuxiliaryStreamTag(p.streamTag) &&
      !isToolTrailStatusStreamTag(p.streamTag),
  );
}

/** Primary (main) live stream: outer `agent` chunks. */
export function primaryStreamPartsForDisplay(
  parts: StreamPart[],
  _processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return parts.filter((p) => isPrimaryAssistantStreamTag(p.streamTag));
}

/** Non-primary multiplex segments (reasoning, tools, Clara briefs, tool-trail rows). */
export function delegatedStreamPartsForDisplay(
  parts: StreamPart[],
  _processingAgentRole: LlmAgentRole | null,
): StreamPart[] {
  return parts.filter((p) => !isPrimaryAssistantStreamTag(p.streamTag));
}

/**
 * Non-primary multiplex segments in arrival order. Primary (`agent`) chunks are omitted.
 */
export function multiplexAuxiliaryStreamTimeline(parts: StreamPart[]): StreamPart[] {
  return mergeReadPreviewIntoToolTrailParts(
    parts
      .map(normalizeStreamPart)
      .filter((p): p is StreamPart => p !== null)
      .filter((p) => !isPrimaryAssistantStreamTag(p.streamTag)),
  );
}

/** Subset of persisted assistant fields used to resolve auxiliary timeline for display. */
export type PersistedAssistantStreamFields = {
  auxiliaryStreamTimeline?: StreamPart[];
  toolStreams?: StreamPart[];
  reasoningStreams?: StreamPart[];
  /** Legacy on-disk field from pre-rename builds. */
  moeStreams?: StreamPart[];
};

/**
 * Ordered auxiliary stream for the chat UI: prefer {@link PersistedAssistantStreamFields.auxiliaryStreamTimeline}
 * when present; otherwise merge shell tool streams then reasoning.
 */
export function persistedReasoningStreams(
  assistant: PersistedAssistantStreamFields | null | undefined,
): StreamPart[] | undefined {
  const streams = assistant?.reasoningStreams ?? assistant?.moeStreams;
  if (!streams?.length) {
    return undefined;
  }
  return streams
    .map(normalizeStreamPart)
    .filter((p): p is StreamPart => p !== null)
    .map(normalizeReasoningStreamPart);
}

export function persistedAuxiliaryStreamTimeline(
  assistant: PersistedAssistantStreamFields | null | undefined,
): StreamPart[] {
  if (!assistant) return [];
  const t = assistant.auxiliaryStreamTimeline;
  if (t?.length) {
    return mergeReadPreviewIntoToolTrailParts(
      t
        .map(normalizeStreamPart)
        .filter((p): p is StreamPart => p !== null),
    );
  }
  const tools = mergeReadPreviewIntoToolTrailParts(
    (assistant.toolStreams ?? [])
      .map(normalizeStreamPart)
      .filter((p): p is StreamPart => p !== null),
  );
  return [...tools, ...(persistedReasoningStreams(assistant) ?? [])];
}

/**
 * Persisted assistant line when {@link primaryAssistantTextFromParts} is empty but the stream had
 * multiplexed activity (tools, reasoning sidecar, etc.).
 */
export function emptyPrimaryAssistantFallbackMessage(hasReasoningStreamText: boolean): string {
  if (hasReasoningStreamText) {
    return (
      'No main reply text was saved for this turn (see **Model reasoning** above). ' +
      'Common causes: tool syntax only in plain text (stripped; use real API tool calls), or the ' +
      'provider stopping early on an output/token limit.'
    );
  }
  return 'Workspace tooling finished for this turn. Use the tool trail and nested workspace output above for specifics.';
}

export function primaryAssistantTextFromParts(
  parts: StreamPart[],
  _processingAgentRoleAtEnd: LlmAgentRole | null = null,
): string {
  return parts
    .filter((p) => p.streamTag.trim() === 'agent')
    .map((p) => p.text)
    .join('');
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
