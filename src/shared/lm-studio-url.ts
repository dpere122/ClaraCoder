import { openAiBaseUrlToOrigin } from './safe-http-url';

/**
 * LM Studio serves OpenAI-compatible chat at ``/v1`` and native management APIs at ``/api/v1`` on the same host.
 */
export function lmStudioOpenAiBaseUrlToRestOrigin(baseUrl: string): string | null {
  return openAiBaseUrlToOrigin(baseUrl);
}
