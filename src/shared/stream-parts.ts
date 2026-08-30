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

/** Premature primary prose folded into a nudge preview when the graph jumps back to the model. */
export const NUDGE_STREAM_TAG = 'nudge';

export function isNudgeStreamTag(streamTag: string | undefined): boolean {
  return (streamTag ?? '').trim() === NUDGE_STREAM_TAG;
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
export const RUN_COMMAND_STREAM_TAG_PREFIX = 'run-command:';

export function isRunCommandStreamTag(streamTag: string | undefined): boolean {
  return (streamTag ?? '').trim().startsWith(RUN_COMMAND_STREAM_TAG_PREFIX);
}

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
  if (t === LEGACY_REASONING_STREAM_TAG) {
    return REASONING_AUXILIARY_STREAM_TAG;
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

/** Prefix for display-time HITL change rows merged into the auxiliary timeline. */
export const HITL_TRAIL_STREAM_PREFIX = 'hitl-trail:';

/** Stable multiplex tag for one tool status row (interleaved with reasoning / tool output). */
export function toolTrailStatusStreamTag(statusId: string): string {
  return `${TOOL_TRAIL_STATUS_STREAM_PREFIX}${encodeURIComponent(statusId)}`;
}

export function isToolTrailStatusStreamTag(streamTag: string): boolean {
  return streamTag.trim().startsWith(TOOL_TRAIL_STATUS_STREAM_PREFIX);
}

/** Stable multiplex tag for one HITL change row in the auxiliary timeline. */
export function hitlTrailStreamTag(itemId: string): string {
  return `${HITL_TRAIL_STREAM_PREFIX}${encodeURIComponent(itemId)}`;
}

export function isHitlTrailStreamTag(streamTag: string): boolean {
  return streamTag.trim().startsWith(HITL_TRAIL_STREAM_PREFIX);
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
      !isClaraOuterBriefStreamTag(p.streamTag) &&
      !isNudgeStreamTag(p.streamTag) &&
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

function asClaraOuterBriefPart(part: StreamPart): StreamPart {
  return {
    ...part,
    streamTag: CLARA_OUTER_BRIEF_STREAM_TAG,
    label: part.label || 'Clara',
  };
}

function asNudgeStreamPart(part: StreamPart): StreamPart {
  return {
    ...part,
    streamTag: NUDGE_STREAM_TAG,
    label: part.label || 'Nudge',
  };
}

function pushOrMergeBriefItem(items: TurnFeedItem[], part: StreamPart): void {
  const briefPart = asClaraOuterBriefPart(part);
  const last = items[items.length - 1];
  if (last?.kind === 'brief') {
    last.part = { ...last.part, text: last.part.text + briefPart.text };
    return;
  }
  items.push({ kind: 'brief', part: { ...briefPart } });
}

function pushOrMergeNudgeItem(items: TurnFeedItem[], part: StreamPart): void {
  const nudgePart = asNudgeStreamPart(part);
  const last = items[items.length - 1];
  if (last?.kind === 'nudge') {
    last.part = { ...last.part, text: last.part.text + nudgePart.text };
    return;
  }
  items.push({ kind: 'nudge', part: { ...nudgePart } });
}

/**
 * Tool / HITL / shell lanes. An `agent` segment after one of these is the live reply,
 * not the Clara outer brief.
 */
function streamPartIsToolLike(part: StreamPart): boolean {
  return isToolLikeStreamTag(part.streamTag);
}

/** Tool / HITL / shell multiplex tags (not primary, reasoning, brief, nudge, or planner). */
export function isToolLikeStreamTag(streamTag: string): boolean {
  const tag = streamTag;
  return (
    !isPrimaryAssistantStreamTag(tag) &&
    !isReasoningAuxiliaryStreamTag(tag) &&
    !isClaraOuterBriefStreamTag(tag) &&
    !isNudgeStreamTag(tag) &&
    tag.trim() !== PLANNER_STREAM_TAG
  );
}

function asReasoningStreamPart(part: StreamPart): StreamPart {
  return {
    ...part,
    streamTag: REASONING_AUXILIARY_STREAM_TAG,
    label: part.label || 'Model reasoning',
  };
}

/**
 * Retag live `agent` prose to reasoning when a tool row is about to start.
 * Gemma often streams between-tool thought on the primary lane; once a tool starts
 * that prose is not the final reply and must stay in the auxiliary timeline.
 */
export function promotePrimaryAheadOfToolToReasoning(parts: readonly StreamPart[]): StreamPart[] {
  const out: StreamPart[] = [];
  for (const part of parts) {
    if (!isPrimaryAssistantStreamTag(part.streamTag)) {
      out.push(part);
      continue;
    }
    if (!part.text.trim()) {
      continue;
    }
    const promoted = asReasoningStreamPart(part);
    const last = out[out.length - 1];
    if (last && isReasoningAuxiliaryStreamTag(last.streamTag)) {
      out[out.length - 1] = {
        ...last,
        label: last.label || promoted.label,
        text: last.text + promoted.text,
      };
    } else {
      out.push(promoted);
    }
  }
  return out;
}

function primarySegmentIsBetweenTools(parts: readonly StreamPart[], index: number): boolean {
  let priorTool = false;
  for (let i = 0; i < index; i++) {
    if (streamPartIsToolLike(parts[i]!)) {
      priorTool = true;
      break;
    }
  }
  if (!priorTool) {
    return false;
  }
  for (let i = index + 1; i < parts.length; i++) {
    if (streamPartIsToolLike(parts[i]!)) {
      return true;
    }
  }
  return false;
}

/**
 * Live `agent` text before any tool/HITL lane is the Clara outer brief (planning prose).
 * After tools start, later `agent` segments are the user-visible reply.
 */
export function livePrimaryRendersAsOuterBrief(
  parts: readonly StreamPart[],
  index: number,
): boolean {
  for (let i = 0; i < index; i++) {
    if (streamPartIsToolLike(parts[i]!)) {
      return false;
    }
  }
  return true;
}

function retagPrimaryStreamParts(
  parts: readonly StreamPart[],
  retag: (part: StreamPart) => StreamPart,
  isLane: (streamTag: string) => boolean,
): StreamPart[] {
  const out: StreamPart[] = [];
  for (const part of parts) {
    if (!isPrimaryAssistantStreamTag(part.streamTag)) {
      out.push(part);
      continue;
    }
    if (!part.text.trim()) {
      continue;
    }
    const promoted = retag(part);
    const last = out[out.length - 1];
    if (last && isLane(last.streamTag)) {
      out[out.length - 1] = { ...last, text: last.text + promoted.text };
    } else {
      out.push(promoted);
    }
  }
  return out;
}

/**
 * Promote live primary (`agent`) segments into Clara outer briefs when a tool-calling
 * step starts. Keeps the planning prose in the auxiliary timeline instead of discarding it.
 */
export function clearPrimaryStreamParts(parts: readonly StreamPart[]): StreamPart[] {
  return retagPrimaryStreamParts(parts, asClaraOuterBriefPart, isClaraOuterBriefStreamTag);
}

/**
 * Promote live primary (`agent`) segments into a nudge preview when the graph jumps
 * back to the model (empty / staging / pseudo-tool nudge). The real reply streams later.
 */
export function promotePrimaryToNudgeParts(parts: readonly StreamPart[]): StreamPart[] {
  return retagPrimaryStreamParts(parts, asNudgeStreamPart, isNudgeStreamTag);
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

/** One chronological UI event in the unified live/persisted turn feed. */
export type TurnFeedItem =
  | { kind: 'thought'; part: StreamPart }
  | { kind: 'brief'; part: StreamPart }
  | { kind: 'nudge'; part: StreamPart }
  | { kind: 'tool'; part: StreamPart }
  | { kind: 'markdown'; text: string };

export type BuildTurnFeedOptions = {
  /** When false, live pre-tool `agent` prose renders as markdown instead of a Clara brief. */
  promoteLivePrimaryToBrief?: boolean;
};

/**
 * Build the unified turn feed: thought pills, Clara brief pills, nudge pills, tool pills, and
 * rendered markdown in arrival order.
 * When `finalText` is set, in-feed `agent` segments are omitted except leaked planning
 * between tools (rendered as thought) and a single markdown block is appended at the end
 * (backend `final_text` / persisted `assistant.text`).
 */
export function buildTurnFeed(
  parts: readonly StreamPart[],
  finalText?: string | null,
  options?: BuildTurnFeedOptions,
): TurnFeedItem[] {
  const promoteLivePrimaryToBrief = options?.promoteLivePrimaryToBrief !== false;
  const normalized = mergeReadPreviewIntoToolTrailParts(
    parts.map(normalizeStreamPart).filter((p): p is StreamPart => p !== null),
  );
  const final = (finalText ?? '').trim();
  const items: TurnFeedItem[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const part = normalized[i]!;
    if (isReasoningAuxiliaryStreamTag(part.streamTag)) {
      if (part.text.trim()) {
        items.push({ kind: 'thought', part: normalizeReasoningStreamPart(part) });
      }
      continue;
    }
    if (isClaraOuterBriefStreamTag(part.streamTag)) {
      if (part.text.trim()) {
        pushOrMergeBriefItem(items, part);
      }
      continue;
    }
    if (isNudgeStreamTag(part.streamTag)) {
      if (part.text.trim()) {
        pushOrMergeNudgeItem(items, part);
      }
      continue;
    }
    if (isPrimaryAssistantStreamTag(part.streamTag)) {
      if (!part.text.trim()) {
        continue;
      }
      if (primarySegmentIsBetweenTools(normalized, i)) {
        const thoughtPart = asReasoningStreamPart(part);
        const last = items[items.length - 1];
        if (last?.kind === 'thought') {
          last.part = { ...last.part, text: last.part.text + thoughtPart.text };
        } else {
          items.push({ kind: 'thought', part: thoughtPart });
        }
        continue;
      }
      if (!final) {
        if (promoteLivePrimaryToBrief && livePrimaryRendersAsOuterBrief(normalized, i)) {
          pushOrMergeBriefItem(items, part);
        } else {
          const last = items[items.length - 1];
          if (last?.kind === 'markdown') {
            last.text += part.text;
          } else {
            items.push({ kind: 'markdown', text: part.text });
          }
        }
      }
      continue;
    }
    items.push({ kind: 'tool', part });
  }
  if (final) {
    items.push({ kind: 'markdown', text: final });
  }
  return items;
}

/**
 * True when this thought is the latest live feed event.
 * Live turn-feed preview is owned by the preview queue; these helpers remain for tests
 * and persisted (`live=false`) rendering, which never shows a streaming preview.
 */
export function isActiveLiveThought(
  items: readonly TurnFeedItem[],
  index: number,
  live: boolean,
): boolean {
  return live && items[index]?.kind === 'thought' && index === items.length - 1;
}

/** True when a later feed item means this Clara brief is no longer being generated. */
function briefGenerationSupersededBy(item: TurnFeedItem | undefined): boolean {
  return item?.kind === 'tool' || item?.kind === 'markdown' || item?.kind === 'brief' || item?.kind === 'nudge';
}

/**
 * True while this Clara brief is still being generated (auto-expand the reasoning preview).
 * Later thought tokens do not close it; a tool, markdown reply, or a newer brief does.
 * Live turn-feed preview is owned by the preview queue; this helper remains for tests.
 */
export function isActiveLiveBrief(
  items: readonly TurnFeedItem[],
  index: number,
  live: boolean,
): boolean {
  if (!live || items[index]?.kind !== 'brief') {
    return false;
  }
  for (let i = index + 1; i < items.length; i++) {
    if (briefGenerationSupersededBy(items[i])) {
      return false;
    }
  }
  return true;
}

/** True when a later feed item means this nudge preview is no longer being generated. */
function nudgeGenerationSupersededBy(item: TurnFeedItem | undefined): boolean {
  return item?.kind === 'tool' || item?.kind === 'markdown' || item?.kind === 'nudge';
}

/**
 * True while this nudge preview is still the live premature reply (auto-expand).
 * Later thought or brief tokens do not close it; a tool, markdown reply, or a newer nudge does.
 * Live turn-feed preview is owned by the preview queue; this helper remains for tests.
 */
export function isActiveLiveNudge(
  items: readonly TurnFeedItem[],
  index: number,
  live: boolean,
): boolean {
  if (!live || items[index]?.kind !== 'nudge') {
    return false;
  }
  for (let i = index + 1; i < items.length; i++) {
    if (nudgeGenerationSupersededBy(items[i])) {
      return false;
    }
  }
  return true;
}

/** Fingerprint of feed content for streaming autoscroll dedupe. */
export function turnFeedScrollKey(items: readonly TurnFeedItem[]): string {
  return items
    .map((item) => {
      if (item.kind === 'markdown') {
        return `md:${item.text.length}:${item.text.slice(-80)}`;
      }
      return `${item.kind}:${item.part.streamTag}:${item.part.text.length}`;
    })
    .join('\u001f');
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
