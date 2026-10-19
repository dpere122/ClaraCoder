import { Injectable, signal } from '@angular/core';
import type { TurnActivity } from './chat-box-display';

/** What a mounted chat box is showing for its live turn. */
export interface ShownTurnActivity {
  readonly owner: object;
  readonly conversationId: string;
  readonly activity: TurnActivity;
}

/**
 * The spinner the mounted chat box is actually showing, including the live feed's dwell on the
 * open preview (thought header / tool pill). The conversation list prefers this over the
 * resolver for the active conversation so its row never disagrees with the stream on screen.
 */
@Injectable({ providedIn: 'root' })
export class LiveTurnActivityService {
  readonly shown = signal<ShownTurnActivity | null>(null);

  report(owner: object, conversationId: string | null, activity: TurnActivity | null): void {
    if (!conversationId || !activity) {
      this.clear(owner);
      return;
    }
    const prev = this.shown();
    if (prev?.owner === owner && prev.conversationId === conversationId && prev.activity === activity) {
      return;
    }
    this.shown.set({ owner, conversationId, activity });
  }

  clear(owner: object): void {
    if (this.shown()?.owner === owner) {
      this.shown.set(null);
    }
  }
}
