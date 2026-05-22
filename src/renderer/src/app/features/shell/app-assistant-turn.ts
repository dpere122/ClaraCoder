import type { StreamPart } from '@shared/index';
import {
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isMoeAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  multiplexAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
} from '@shared/index';

export interface AssistantTurnPayload {
  text: string;
  toolStreams?: StreamPart[];
  moeStreams?: StreamPart[];
  auxiliaryStreamTimeline?: StreamPart[];
}

/** Collapse streamed parts into a persisted assistant message (active or background conversation). */
export function buildAssistantTurnFromStreamParts(
  parts: StreamPart[],
  pendingFinalText: string | undefined,
): AssistantTurnPayload | null {
  const toolStreamCandidates = delegatedStreamPartsForDisplay(parts, null).filter(
    (p) => isShellStyleToolStreamTag(p.streamTag) && p.text.trim(),
  );
  const toolStreams = toolStreamCandidates.length > 0 ? toolStreamCandidates : undefined;
  const moeCandidates = parts.filter((p) => isMoeAuxiliaryStreamTag(p.streamTag) && p.text.trim());
  const moeStreams = moeCandidates.length > 0 ? moeCandidates : undefined;
  const timelineParts = multiplexAuxiliaryStreamTimeline(parts);
  const auxiliaryStreamTimeline = timelineParts.length > 0 ? timelineParts : undefined;
  const hasReasoningStreamText = moeCandidates.length > 0;

  let text = pendingFinalText ?? '';
  if (!text.trim()) {
    text = primaryAssistantTextFromParts(parts);
  }
  if (
    !text.trim() &&
    (parts.length > 0 ||
      (toolStreams?.length ?? 0) > 0 ||
      (moeStreams?.length ?? 0) > 0 ||
      (auxiliaryStreamTimeline?.length ?? 0) > 0)
  ) {
    text = emptyPrimaryAssistantFallbackMessage(hasReasoningStreamText);
  }

  if (
    !text.trim() &&
    (toolStreams?.length ?? 0) === 0 &&
    (moeStreams?.length ?? 0) === 0 &&
    (auxiliaryStreamTimeline?.length ?? 0) === 0
  ) {
    return null;
  }

  return { text, toolStreams, moeStreams, auxiliaryStreamTimeline };
}
