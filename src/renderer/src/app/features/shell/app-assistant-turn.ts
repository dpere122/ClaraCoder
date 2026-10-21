import type { StreamPart, TurnEndedEarly } from '@shared/index';
import {
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isReasoningAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  multiplexAuxiliaryStreamTimeline,
  normalizeReasoningStreamPart,
  normalizeStreamPart,
  primaryAssistantTextFromParts,
} from '@shared/index';

export interface AssistantTurnPayload {
  text: string;
  toolStreams?: StreamPart[];
  reasoningStreams?: StreamPart[];
  auxiliaryStreamTimeline?: StreamPart[];
}

/**
 * Collapse streamed parts into a persisted assistant message (active or background conversation).
 * `endedEarly` turns keep only what streamed: no "tooling finished" placeholder for a reply that
 * never got to write one.
 */
export function buildAssistantTurnFromStreamParts(
  parts: StreamPart[],
  pendingFinalText: string | undefined,
  opts?: { endedEarly?: TurnEndedEarly },
): AssistantTurnPayload | null {
  const normalizedParts = parts
    .map(normalizeStreamPart)
    .filter((p): p is StreamPart => p !== null);
  const toolStreamCandidates = delegatedStreamPartsForDisplay(normalizedParts, null).filter(
    (p) => isShellStyleToolStreamTag(p.streamTag) && p.text.trim(),
  );
  const toolStreams = toolStreamCandidates.length > 0 ? toolStreamCandidates : undefined;
  const reasoningCandidates = normalizedParts
    .filter((p) => isReasoningAuxiliaryStreamTag(p.streamTag) && p.text.trim())
    .map(normalizeReasoningStreamPart);
  const reasoningStreams = reasoningCandidates.length > 0 ? reasoningCandidates : undefined;
  const timelineParts = multiplexAuxiliaryStreamTimeline(normalizedParts).map(normalizeReasoningStreamPart);
  const auxiliaryStreamTimeline = timelineParts.length > 0 ? timelineParts : undefined;
  const hasReasoningStreamText = reasoningCandidates.length > 0;

  let text = pendingFinalText ?? '';
  if (!text.trim()) {
    text = primaryAssistantTextFromParts(normalizedParts);
  }
  if (
    !text.trim() &&
    !opts?.endedEarly &&
    (parts.length > 0 ||
      (toolStreams?.length ?? 0) > 0 ||
      (reasoningStreams?.length ?? 0) > 0 ||
      (auxiliaryStreamTimeline?.length ?? 0) > 0)
  ) {
    text = emptyPrimaryAssistantFallbackMessage(hasReasoningStreamText);
  }

  if (
    !text.trim() &&
    (toolStreams?.length ?? 0) === 0 &&
    (reasoningStreams?.length ?? 0) === 0 &&
    (auxiliaryStreamTimeline?.length ?? 0) === 0
  ) {
    return null;
  }

  return { text, toolStreams, reasoningStreams, auxiliaryStreamTimeline };
}
