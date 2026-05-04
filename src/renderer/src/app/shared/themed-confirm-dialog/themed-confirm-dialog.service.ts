import { Injectable, signal } from '@angular/core';

export type ThemedConfirmVariant = 'default' | 'warning';

export interface ThemedConfirmOpenOptions {
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ThemedConfirmVariant;
}

interface ActiveConfirm extends ThemedConfirmOpenOptions {
  confirmText: string;
  cancelText: string;
  variant: ThemedConfirmVariant;
  resolve: (confirmed: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ThemedConfirmDialogService {
  /** When non-null, the themed confirm overlay is shown. */
  readonly active = signal<ActiveConfirm | null>(null);

  open(opts: ThemedConfirmOpenOptions): Promise<boolean> {
    const cur = this.active();
    if (cur) {
      cur.resolve(false);
    }
    return new Promise((resolve) => {
      this.active.set({
        ...opts,
        confirmText: opts.confirmText?.trim() || 'OK',
        cancelText: opts.cancelText?.trim() || 'Cancel',
        variant: opts.variant ?? 'default',
        resolve,
      });
    });
  }

  close(confirmed: boolean): void {
    const cur = this.active();
    if (!cur) {
      return;
    }
    cur.resolve(confirmed);
    this.active.set(null);
  }
}
