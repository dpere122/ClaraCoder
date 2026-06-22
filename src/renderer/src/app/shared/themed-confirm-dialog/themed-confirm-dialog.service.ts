import { Injectable, signal } from '@angular/core';

export type ThemedConfirmVariant = 'default' | 'warning';

export type ThemedConfirmResult = 'confirm' | 'middle' | 'cancel';

export interface ThemedConfirmOpenOptions {
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  /** Optional third action (e.g. Save As between cancel and confirm). */
  middleText?: string;
  variant?: ThemedConfirmVariant;
}

interface ActiveConfirm extends ThemedConfirmOpenOptions {
  confirmText: string;
  cancelText: string;
  middleText?: string;
  variant: ThemedConfirmVariant;
  resolve: (result: ThemedConfirmResult) => void;
}

@Injectable({ providedIn: 'root' })
export class ThemedConfirmDialogService {
  /** When non-null, the themed confirm overlay is shown. */
  readonly active = signal<ActiveConfirm | null>(null);

  open(opts: ThemedConfirmOpenOptions): Promise<ThemedConfirmResult> {
    const cur = this.active();
    if (cur) {
      cur.resolve('cancel');
    }
    return new Promise((resolve) => {
      this.active.set({
        ...opts,
        confirmText: opts.confirmText?.trim() || 'OK',
        cancelText: opts.cancelText?.trim() || 'Cancel',
        middleText: opts.middleText?.trim() || undefined,
        variant: opts.variant ?? 'default',
        resolve,
      });
    });
  }

  /** @deprecated Prefer {@link open} which returns {@link ThemedConfirmResult}. */
  openBoolean(opts: ThemedConfirmOpenOptions): Promise<boolean> {
    return this.open(opts).then((r) => r === 'confirm');
  }

  close(result: ThemedConfirmResult): void {
    const cur = this.active();
    if (!cur) {
      return;
    }
    cur.resolve(result);
    this.active.set(null);
  }
}
