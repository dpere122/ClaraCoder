import type { StreamPart } from './types/conversation';
import { isReadToolPreviewStreamTag, isWorkspaceReadToolLabel } from './stream-parts';

const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const ANSI_OTHER = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?9;]*[ -/]*[@-~]/g;

/** Flatten whitespace for single-line pill meta. */
export function condenseToolTrailText(text: string, maxLen = 72): string {
  const oneLine = text.replace(ANSI_SGR, '').replace(ANSI_OTHER, '').replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '';
  }
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLen - 1).trimEnd()}…`;
}

/** Strip ANSI and return the last non-empty lines for terminal preview. */
export function terminalTailPreview(text: string, maxLines = 4): string {
  const stripped = text.replace(ANSI_OTHER, '').replace(ANSI_SGR, '');
  const lines = stripped.split('\n');
  const nonEmpty: string[] = [];
  for (const line of lines) {
    if (line.trim()) {
      nonEmpty.push(line);
    }
  }
  if (nonEmpty.length === 0) {
    return stripped.trimEnd().split('\n').slice(-maxLines).join('\n');
  }
  return nonEmpty.slice(-maxLines).join('\n');
}

export function shellStreamPartBadgeMeta(part: StreamPart, live: boolean): string {
  if (!part.runComplete && live) {
    return 'Running…';
  }
  if (part.outcome === 'passed') {
    return 'Passed';
  }
  if (part.outcome === 'failed') {
    return 'Failed';
  }
  if (part.exitCode === 0) {
    return 'Exit 0';
  }
  if (part.exitCode != null && part.exitCode !== undefined) {
    return `Exit ${part.exitCode}`;
  }
  if (part.runComplete) {
    return 'Complete';
  }
  const tail = condenseToolTrailText(terminalTailPreview(part.text, 1), 48);
  return tail || 'Running…';
}

/** Start of streamed read body in multiplex text (see Python ``iter_read_tool_stream_sse``). */
export const READ_TOOL_STREAM_BODY_MARKER = '\n\n── ';

/** Path or status line before streamed read body (`── tool ──` separator). */
export function readToolStatusHeadline(text: string): string {
  const marker = text.indexOf(READ_TOOL_STREAM_BODY_MARKER);
  const head = (marker >= 0 ? text.slice(0, marker) : text).trim();
  return head;
}

export function readToolPreviewBody(text: string): string {
  const marker = text.indexOf(READ_TOOL_STREAM_BODY_MARKER);
  if (marker < 0) {
    return '';
  }
  return text.slice(marker + 1).trimStart();
}

/** Last few lines of streamed read output for the collapsed pill preview. */
export function readToolPreviewTail(text: string, maxLines = 4): string {
  const body = readToolPreviewBody(text);
  if (!body.trim()) {
    return '';
  }
  return terminalTailPreview(body, maxLines);
}

/** Tail lines for the collapsed read preview (marker body, else last lines of headline). */
export function readToolPreviewTailForDisplay(text: string, maxLines = 4): string {
  const bodyTail = readToolPreviewTail(text, maxLines);
  if (bodyTail.trim()) {
    return bodyTail;
  }
  return terminalTailPreview(text, maxLines);
}

export function toolStatusStreamPartMeta(part: StreamPart): string {
  if (isWorkspaceReadToolLabel(part.label)) {
    const head = readToolStatusHeadline(part.text);
    if (head) {
      return condenseToolTrailText(head, 64);
    }
  }
  if (part.toolChainState === 'running') {
    return condenseToolTrailText(part.text, 64) || 'Running…';
  }
  if (part.toolChainState === 'error') {
    return condenseToolTrailText(part.text, 64) || 'Error';
  }
  return condenseToolTrailText(part.text, 64) || 'Done';
}

export function delegatedStreamPartMeta(part: StreamPart): string {
  const tail = condenseToolTrailText(part.text, 64);
  if (tail) {
    return tail;
  }
  if (part.runComplete) {
    return 'Complete';
  }
  return 'Output';
}

export type ToolTrailPillState = 'running' | 'complete' | 'error' | 'neutral';

export function toolStatusStreamPartPillState(part: StreamPart): ToolTrailPillState {
  if (part.toolStopped) {
    // Cut off when its turn was stopped or interrupted: it never finished, but it did not fail.
    return 'neutral';
  }
  if (part.toolChainState === 'running') {
    return 'running';
  }
  if (part.toolChainState === 'error') {
    return 'error';
  }
  return 'complete';
}

export function shellStreamPartPillState(part: StreamPart, live: boolean): ToolTrailPillState {
  if (!part.runComplete && live) {
    return 'running';
  }
  if (part.outcome === 'failed' || (part.exitCode != null && part.exitCode !== 0)) {
    return 'error';
  }
  if (part.outcome === 'passed' || part.exitCode === 0 || part.runComplete) {
    return 'complete';
  }
  return 'neutral';
}

/** True when the part has detail worth revealing on expand. */
export function streamPartIsExpandable(part: StreamPart, kind: 'status' | 'shell' | 'delegated'): boolean {
  if (kind === 'shell') {
    return true;
  }
  if (part.toolSubagentId) {
    // The expanded body carries the Open link even before the sub-agent reports back.
    return true;
  }
  if (isReadToolPreviewStreamTag(part.streamTag)) {
    return readToolPreviewBody(part.text).trim().length > 0 || part.text.trim().length > 0;
  }
  if (isWorkspaceReadToolLabel(part.label) || isReadToolPreviewStreamTag(part.streamTag)) {
    return part.text.trim().length > 0;
  }
  return part.text.trim().length > 0;
}

/** Whether a tool-trail / chain row should show the collapsed read-file tail preview. */
export function shouldShowReadToolPreview(
  text: string,
  label: string,
  streamTag = '',
): boolean {
  const readRow =
    isWorkspaceReadToolLabel(label) ||
    (streamTag.trim() !== '' && isReadToolPreviewStreamTag(streamTag));
  if (!readRow || !text.trim()) {
    return false;
  }
  return readToolPreviewTailForDisplay(text).trim().length > 0;
}
