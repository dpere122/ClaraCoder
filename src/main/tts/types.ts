export interface TtsRequestParams {
  text: string;
  voice: string;
  speed: number;
  /** OpenAI-compatible style / mood instructions (Qwen ``instruct``); ignored by Kokoro. */
  instructions?: string;
}
