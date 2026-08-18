import type { ChatTemplateReasoningCaps } from '../shared';

const byModelId = new Map<string, ChatTemplateReasoningCaps>();
const nCtxByModelId = new Map<string, number>();

export function setCachedChatTemplateReasoning(modelId: string, caps: ChatTemplateReasoningCaps): void {
  byModelId.set(modelId, caps);
}

export function setCachedLlamaServerNctx(modelId: string, nCtx: number): void {
  nCtxByModelId.set(modelId, nCtx);
}

export function clearCachedChatTemplateReasoning(modelId: string): void {
  byModelId.delete(modelId);
  nCtxByModelId.delete(modelId);
}

export function getCachedChatTemplateReasoning(modelId: string): ChatTemplateReasoningCaps | undefined {
  return byModelId.get(modelId);
}

export function getCachedLlamaServerNctx(modelId: string): number | undefined {
  return nCtxByModelId.get(modelId);
}

export function getAllCachedChatTemplateReasoning(): Record<string, ChatTemplateReasoningCaps> {
  return Object.fromEntries(byModelId);
}

export function getAllCachedLlamaServerNctx(): Record<string, number> {
  return Object.fromEntries(nCtxByModelId);
}
