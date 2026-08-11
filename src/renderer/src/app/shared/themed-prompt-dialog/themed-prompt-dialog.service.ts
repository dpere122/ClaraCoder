import { Injectable, signal } from '@angular/core';

export type ThemedPromptVariant = 'default' | 'warning';

export interface ThemedPromptOpenOptions {
  title: string;
  message?: string;
  /** Initial value for the input field. */
  value?: string;
  /** Optional placeholder when the value is empty. */
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ThemedPromptVariant;
}

interface ActivePrompt extends Required<Omit<ThemedPromptOpenOptions, 'message' | 'placeholder'>> {
  message?: string;
  placeholder?: string;
  resolve: (result: string | null) => void;
}

@Injectable({ providedIn: 'root' })
export class ThemedPromptDialogService {
  /** When non-null, the themed prompt overlay is shown. */
  readonly active = signal<ActivePrompt | null>(null);

  /**
   * Opens a single-line prompt dialog. Resolves with the trimmed entered
   * value on confirm, or `null` on cancel / backdrop / Escape.
   */
  open(opts: ThemedPromptOpenOptions): Promise<string | null> {
    const cur = this.active();
    if (cur) {
      cur.resolve(null);
    }
    return new Promise((resolve) => {
      this.active.set({
        title: opts.title,
        message: opts.message,
        value: opts.value ?? '',
        placeholder: opts.placeholder,
        confirmText: opts.confirmText?.trim() || 'OK',
        cancelText: opts.cancelText?.trim() || 'Cancel',
        variant: opts.variant ?? 'default',
        resolve,
      });
    });
  }

  /** Called by the component with the raw input value (or null on cancel). */
  close(value: string | null): void {
    const cur = this.active();
    if (!cur) {
      return;
    }
    cur.resolve(value);
    this.active.set(null);
  }
}
