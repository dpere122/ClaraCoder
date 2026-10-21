import type { LlmStatus, StreamPart } from '@shared/index';
import {
  CLARA_OUTER_BRIEF_STREAM_TAG,
  clearPrimaryStreamParts,
  isClaraOuterBriefStreamTag,
  isReasoningAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  isToolLikeStreamTag,
  isWorkspaceReadToolLabel,
  mergeReadPreviewIntoToolTrailParts,
  normalizeStreamTag,
  READ_TOOL_STREAM_BODY_MARKER,
  toolTargetFromRunningDetail,
  toolTrailStatusStreamTag,
} from '@shared/index';

/** Matches streamed read-tool body prefix from {@link appendReadToolPreviewChunk}. */
const READ_TOOL_PREVIEW_MARKER = READ_TOOL_STREAM_BODY_MARKER;

export const DEFAULT_REASONING_STREAM_LABEL = 'Model reasoning';

export function appendStreamPart(
  parts: StreamPart[],
  streamTag: string | undefined,
  delta: string,
  label = '',
  now = Date.now(),
): StreamPart[] {
  const raw = streamTag?.trim();
  if (!raw) {
    return appendStreamPartWithTag(parts, 'agent', delta, label, now);
  }
  const t = normalizeStreamTag(raw);
  if (t === null) {
    return parts;
  }
  return appendStreamPartWithTag(parts, t, delta, label, now);
}

function appendStreamPartWithTag(
  parts: StreamPart[],
  t: string,
  delta: string,
  label: string,
  now: number,
): StreamPart[] {
  const reasoning = isReasoningAuxiliaryStreamTag(t);
  const resolvedLabel = label || (reasoning ? DEFAULT_REASONING_STREAM_LABEL : '');
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.streamTag === t) {
    next[next.length - 1] = { ...last, label: last.label || resolvedLabel, text: last.text + delta };
    return next;
  }
  const closed = closeOpenThought(next, now);
  const base = isToolLikeStreamTag(t) ? clearPrimaryStreamParts(closed) : closed;
  return [...base, { streamTag: t, label: resolvedLabel, text: delta, ...(reasoning ? { thoughtStartedAt: now } : {}) }];
}

/**
 * Stamp how long the trailing reasoning segment ran once something else follows it (the next
 * segment begins, or the turn ends). Parts without a start time (older turns) are left alone.
 */
export function closeOpenThought(parts: StreamPart[], now = Date.now()): StreamPart[] {
  const last = parts[parts.length - 1];
  if (
    !last ||
    !isReasoningAuxiliaryStreamTag(last.streamTag) ||
    last.thoughtStartedAt === undefined ||
    last.thoughtDurationMs !== undefined
  ) {
    return parts;
  }
  const next = [...parts];
  next[next.length - 1] = { ...last, thoughtDurationMs: Math.max(0, now - last.thoughtStartedAt) };
  return next;
}

/**
 * Keep streamed read preview text when a later status row only updates headline / state.
 * Without this, the `complete` one-liner overwrites chunks appended via `tool_read_chunk`.
 */
export function mergeToolTrailStatusText(
  prev: StreamPart | undefined,
  incoming: Pick<StreamPart, 'label' | 'text'>,
): string {
  const incomingText = incoming.text ?? '';
  if (!prev?.text?.includes(READ_TOOL_PREVIEW_MARKER) || !isWorkspaceReadToolLabel(incoming.label)) {
    return incomingText;
  }
  if (incomingText.includes(READ_TOOL_PREVIEW_MARKER)) {
    return incomingText;
  }
  const markerIdx = prev.text.indexOf(READ_TOOL_PREVIEW_MARKER);
  const previewBody = prev.text.slice(markerIdx);
  const headline = incomingText.trim();
  if (!headline) {
    return prev.text;
  }
  return `${headline}${previewBody}`;
}

/** Fold a Clara outer-brief status row into the multiplex timeline (source is `agent`, not `tool`). */
export function upsertClaraOuterBriefStreamPart(
  parts: StreamPart[],
  status: LlmStatus,
  now = Date.now(),
): StreamPart[] {
  if (!isClaraOuterBriefStreamTag(status.streamTag)) {
    return parts;
  }
  const text = (status.detail ?? '').trim();
  if (!text) {
    return parts;
  }
  if (parts.some((p) => isClaraOuterBriefStreamTag(p.streamTag) && p.text.includes(text))) {
    return parts;
  }
  const last = parts[parts.length - 1];
  if (last && isClaraOuterBriefStreamTag(last.streamTag)) {
    const next = [...parts];
    next[next.length - 1] = {
      ...last,
      text: last.text.endsWith('\n') ? `${last.text}${text}` : `${last.text}\n${text}`,
    };
    return next;
  }
  return [
    ...closeOpenThought(parts, now),
    {
      streamTag: CLARA_OUTER_BRIEF_STREAM_TAG,
      label: status.label || 'Clara',
      text,
    },
  ];
}

/** Insert or update a tool-status row in the multiplex timeline (wall-clock order vs. reasoning chunks). */
export function upsertToolTrailStatusStreamPart(
  parts: StreamPart[],
  status: LlmStatus,
  now = Date.now(),
): StreamPart[] {
  const src = (status.source ?? 'agent').toLowerCase();
  if (src !== 'tool') {
    return upsertClaraOuterBriefStreamPart(parts, status, now);
  }
  const streamTag = toolTrailStatusStreamTag(status.id);
  const next = [...parts];
  const idx = next.findIndex((p) => p.streamTag === streamTag);
  // The first running detail names the call's path / query; the completed status overwrites
  // `text` with the result, so keep it as the pill target.
  const target =
    status.state === 'running' && !next[idx]?.toolTarget ? toolTargetFromRunningDetail(status.detail ?? '') : '';
  const row: StreamPart = {
    streamTag,
    label: status.label,
    text: status.detail ?? '',
    toolChainState: status.state,
    ...(status.toolBatch ? { toolBatch: status.toolBatch } : {}),
    ...(target ? { toolTarget: target } : {}),
    ...(status.toolDiff ? { toolDiff: status.toolDiff } : {}),
    ...(status.durationMs !== undefined ? { toolDurationMs: status.durationMs } : {}),
    // Later statuses without the link (e.g. a plain progress update) keep it via the merge below.
    ...(status.subagent
      ? { toolSubagentId: status.subagent.conversationId, toolSubagentName: status.subagent.name }
      : {}),
  };
  if (idx >= 0) {
    const prev = next[idx];
    const text = mergeToolTrailStatusText(prev, row);
    next[idx] = { ...prev, ...row, text };
    return mergeReadPreviewIntoToolTrailParts(next);
  }
  return mergeReadPreviewIntoToolTrailParts([
    ...clearPrimaryStreamParts(closeOpenThought(next, now)),
    row,
  ]);
}

export function markToolExecStreamComplete(
  parts: StreamPart[],
  streamTag: string | undefined,
  exitCode: number | null | undefined,
  outputExcerpt?: string,
  outcome?: 'passed' | 'failed',
): StreamPart[] {
  const raw = streamTag?.trim();
  const t = raw ? normalizeStreamTag(raw) : null;
  const next = parts.map((p) => ({ ...p }));
  const ex = outputExcerpt?.trim();

  let targetIdx = -1;
  if (t) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].streamTag.trim() === t) {
        targetIdx = i;
        break;
      }
    }
  } else {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].runComplete) continue;
      const tag = next[i].streamTag?.trim() ?? '';
      if (isShellStyleToolStreamTag(tag)) {
        targetIdx = i;
        break;
      }
    }
  }

  if (targetIdx < 0) {
    return parts;
  }

  let text = next[targetIdx].text;
  if (ex) {
    const head = ex.slice(0, Math.min(160, ex.length));
    if (!text.trim()) {
      text = ex;
    } else if (!text.includes(head)) {
      text = `${text.endsWith('\n') ? text : `${text}\n`}\n${ex}`;
    }
  }
  next[targetIdx] = {
    ...next[targetIdx],
    text,
    runComplete: true,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(outcome ? { outcome } : {}),
  };
  return next;
}
