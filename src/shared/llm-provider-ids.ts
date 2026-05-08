/** Stable id for the pinned LM Studio row in Settings → Models (never deleted, provider fixed). */
export const PINNED_LM_STUDIO_PROVIDER_ID = 'lm-studio-default';

/** Pinned “remote llama-server” row (URL + optional key; no managed Start). */
export const PINNED_LLAMA_SERVER_URL_PROVIDER_ID = 'llama-server-url-default';

/** Pinned managed ``llama-server`` on this machine (Start from chat sidebar). */
export const PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID = 'llamacpp-local-default';

export function isPinnedLmStudioProviderId(id: string): boolean {
  return id === PINNED_LM_STUDIO_PROVIDER_ID;
}

export function isPinnedLlamaServerUrlProviderId(id: string): boolean {
  return id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID;
}

export function isPinnedLlamaCppLocalProviderId(id: string): boolean {
  return id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID;
}

export function isPinnedLlmSourceId(id: string): boolean {
  return (
    isPinnedLmStudioProviderId(id) || isPinnedLlamaServerUrlProviderId(id) || isPinnedLlamaCppLocalProviderId(id)
  );
}