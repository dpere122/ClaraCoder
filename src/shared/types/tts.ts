/** Chunked TTS audio streamed from main → renderer (`tts-stream-packet` IPC). */
export type TtsStreamPacket =
  | { kind: 'chunk'; seq: number; data: Uint8Array }
  | { kind: 'end'; seq: number }
  | { kind: 'error'; seq: number; message: string };
