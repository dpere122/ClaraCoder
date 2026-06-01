import { Injectable, signal } from '@angular/core';

/** Brief filename toast in the chat status bar when the workspace tree detects disk changes. */
@Injectable({ providedIn: 'root' })
export class WorkspaceFileChangeStatusService {
  readonly fileName = signal('');
  readonly visible = signal(false);
  readonly fading = signal(false);

  private static readonly VISIBLE_MS = 2_500;
  private static readonly FADE_MS = 400;

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  showFileName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
      this.clear();
      return;
    }
    this.clearTimers();
    this.fileName.set(trimmed);
    this.fading.set(false);
    this.visible.set(true);
    this.hideTimer = setTimeout(() => {
      this.fading.set(true);
      this.fadeTimer = setTimeout(() => {
        this.visible.set(false);
        this.fading.set(false);
        this.fileName.set('');
      }, WorkspaceFileChangeStatusService.FADE_MS);
    }, WorkspaceFileChangeStatusService.VISIBLE_MS);
  }

  clear(): void {
    this.clearTimers();
    this.visible.set(false);
    this.fading.set(false);
    this.fileName.set('');
  }

  private clearTimers(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }
}
