import type { LlmStatus, StreamPart } from '@shared/index';
import {
  isReasoningAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  isWorkspaceReadToolLabel,
  mergeReadPreviewIntoToolTrailParts,
  normalizeStreamTag,
  READ_TOOL_STREAM_BODY_MARKER,
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
): StreamPart[] {
  const raw = streamTag?.trim();
  if (!raw) {
    return appendStreamPartWithTag(parts, 'agent', delta, label);
  }
  const t = normalizeStreamTag(raw);
  if (t === null) {
    return parts;
  }
  return appendStreamPartWithTag(parts, t, delta, label);
}

function appendStreamPartWithTag(
  parts: StreamPart[],
  t: string,
  delta: string,
  label: string,
): StreamPart[] {
  const resolvedLabel = label || (isReasoningAuxiliaryStreamTag(t) ? DEFAULT_REASONING_STREAM_LABEL : '');
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.streamTag === t) {
    next[next.length - 1] = { ...last, label: last.label || resolvedLabel, text: last.text + delta };
    return next;
  }
  next.push({ streamTag: t, label: resolvedLabel, text: delta });
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

/** Insert or update a tool-status row in the multiplex timeline (wall-clock order vs. reasoning chunks). */
export function upsertToolTrailStatusStreamPart(parts: StreamPart[], status: LlmStatus): StreamPart[] {
  const src = (status.source ?? 'agent').toLowerCase();
  if (src !== 'tool') {
    return parts;
  }
  const streamTag = toolTrailStatusStreamTag(status.id);
  const next = [...parts];
  const idx = next.findIndex((p) => p.streamTag === streamTag);
  const row: StreamPart = {
    streamTag,
    label: status.label,
    text: status.detail ?? '',
    toolChainState: status.state,
  };
  if (idx >= 0) {
    const prev = next[idx];
    const text = mergeToolTrailStatusText(prev, row);
    next[idx] = { ...prev, ...row, text };
    return mergeReadPreviewIntoToolTrailParts(next);
  }
  return mergeReadPreviewIntoToolTrailParts([...next, row]);
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
