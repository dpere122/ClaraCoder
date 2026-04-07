import { Injectable, signal } from '@angular/core';

/** Shared talk-mode phase flags for chat UI (ngx-spinner + labels). */
@Injectable({ providedIn: 'root' })
export class TalkUiState {
  /** Voice activity is being buffered for an utterance. */
  readonly capturing = signal(false);
  /** Utterance audio is being sent for transcription. */
  readonly transcribing = signal(false);

  reset(): void {
    this.capturing.set(false);
    this.transcribing.set(false);
  }
}
