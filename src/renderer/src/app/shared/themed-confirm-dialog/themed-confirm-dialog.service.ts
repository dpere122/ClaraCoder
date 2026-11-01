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
  /** Optional checkbox shown above the actions (e.g. "Don't ask again"). */
  checkboxLabel?: string;
}

interface ActiveConfirm extends ThemedConfirmOpenOptions {
  confirmText: string;
  cancelText: string;
  middleText?: string;
  variant: ThemedConfirmVariant;
  /**
   * Mutable per-dialog checkbox state. Present only for
   * {@link ThemedConfirmDialogService.openWithCheckbox}, so a dialog that replaces this one can
   * never read the other dialog's tick.
   */
  checkbox?: { checked: boolean };
  resolve: (result: ThemedConfirmResult) => void;
}

/** Result of {@link ThemedConfirmDialogService.openWithCheckbox}. */
export interface ThemedConfirmCheckboxResult {
  result: ThemedConfirmResult;
  /** Whether the optional checkbox was ticked when the dialog closed. */
  checked: boolean;
}

@Injectable({ providedIn: 'root' })
export class ThemedConfirmDialogService {
  /** When non-null, the themed confirm overlay is shown. */
  readonly active = signal<ActiveConfirm | null>(null);
  /** Checkbox state for the active dialog (see {@link openWithCheckbox}). */
  readonly checkboxChecked = signal(false);

  open(opts: ThemedConfirmOpenOptions): Promise<ThemedConfirmResult> {
    const cur = this.active();
    if (cur) {
      cur.resolve('cancel');
    }
    this.checkboxChecked.set(false);
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

  /**
   * Like {@link open}, but shows a checkbox and resolves with both the chosen action and
   * whether the checkbox was ticked (e.g. "Don't ask again").
   */
  openWithCheckbox(
    opts: ThemedConfirmOpenOptions & { checkboxLabel: string },
  ): Promise<ThemedConfirmCheckboxResult> {
    const cur = this.active();
    if (cur) {
      cur.resolve('cancel');
    }
    this.checkboxChecked.set(false);
    return new Promise((resolve) => {
      const entry: ActiveConfirm = {
        ...opts,
        confirmText: opts.confirmText?.trim() || 'OK',
        cancelText: opts.cancelText?.trim() || 'Cancel',
        middleText: opts.middleText?.trim() || undefined,
        variant: opts.variant ?? 'default',
        checkbox: { checked: false },
        // Read this dialog's own tick, never the shared signal: a dialog opened later resets the
        // signal before this promise's continuation runs.
        resolve: (result) => resolve({ result, checked: entry.checkbox?.checked === true }),
      };
      this.active.set(entry);
    });
  }

  setCheckboxChecked(checked: boolean): void {
    const next = !!checked;
    this.checkboxChecked.set(next);
    const cur = this.active();
    if (cur?.checkbox) {
      cur.checkbox.checked = next;
    }
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
