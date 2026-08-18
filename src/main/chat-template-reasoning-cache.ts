import type { ChatTemplateReasoningCaps } from '../shared';

const byModelId = new Map<string, ChatTemplateReasoningCaps>();

export function setCachedChatTemplateReasoning(modelId: string, caps: ChatTemplateReasoningCaps): void {
  byModelId.set(modelId, caps);
}

export function clearCachedChatTemplateReasoning(modelId: string): void {
  byModelId.delete(modelId);
}

export function getCachedChatTemplateReasoning(modelId: string): ChatTemplateReasoningCaps | undefined {
  return byModelId.get(modelId);
}

export function getAllCachedChatTemplateReasoning(): Record<string, ChatTemplateReasoningCaps> {
  return Object.fromEntries(byModelId);
}
