import {
  Component,
  ElementRef,
  HostListener,
  inject,
  viewChild,
  signal,
  effect,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThemedPromptDialogService } from './themed-prompt-dialog.service';

@Component({
  selector: 'app-themed-prompt-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (dialog.active(); as req) {
      <div
        class="tpd-backdrop"
        role="presentation"
        (click)="onBackdrop($event)"
      >
        <div
          class="tpd-panel"
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="'tpd-title'"
          (click)="$event.stopPropagation()"
        >
          <h2 class="tpd-title" id="tpd-title">{{ req.title }}</h2>
          @if (req.message?.trim()) {
            <p class="tpd-message">{{ req.message }}</p>
          }
          <input
            #input
            class="tpd-input"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            [placeholder]="req.placeholder ?? ''"
            [ngModel]="value()"
            (ngModelChange)="value.set($event)"
            (keydown.enter)="onConfirm()"
            (keydown.escape)="onCancel()"
          />
          <div class="tpd-actions">
            <button type="button" class="tpd-btn tpd-btn--secondary" (click)="onCancel()">
              {{ req.cancelText }}
            </button>
            <button
              type="button"
              class="tpd-btn tpd-btn--primary"
              [class.tpd-btn--warning]="req.variant === 'warning'"
              (click)="onConfirm()"
            >
              {{ req.confirmText }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .tpd-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      box-sizing: border-box;
      background: color-mix(in srgb, var(--t-bg-deep, #020402) 78%, transparent);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
    }

    .tpd-panel {
      width: min(28rem, 100%);
      max-height: min(80vh, 100%);
      overflow: auto;
      padding: 1.25rem 1.35rem 1.15rem;
      border-radius: 8px;
      border: 1px solid var(--t-border, #00ff4133);
      background: var(--t-bg-surface, #0d1a0d);
      color: var(--t-fg, #00ff41);
      box-shadow: var(--t-elev-shadow, 0 10px 28px rgba(0, 0, 0, 0.45));
      font-family: var(--t-font-mono, monospace);
    }

    .tpd-title {
      margin: 0 0 0.65rem;
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--t-fg, #00ff41);
    }

    .tpd-message {
      margin: 0 0 0.75rem;
      font-size: 0.82rem;
      line-height: 1.45;
      color: color-mix(in srgb, var(--t-fg, #00ff41) 92%, transparent);
    }

    .tpd-input {
      width: 100%;
      box-sizing: border-box;
      margin: 0 0 1rem;
      padding: 0.5rem 0.6rem;
      border-radius: 4px;
      border: 1px solid var(--t-border-subtle, #00ff4122);
      background: var(--t-bg-deep, #060a06);
      color: var(--t-fg, #00ff41);
      font-family: inherit;
      font-size: 0.85rem;
      outline: none;
    }

    .tpd-input:focus {
      border-color: color-mix(in srgb, var(--t-primary, #00ff41) 65%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--t-primary, #00ff41) 22%, transparent);
    }

    .tpd-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .tpd-btn {
      min-width: 6.5rem;
      padding: 0.4rem 0.85rem;
      border-radius: 4px;
      font-size: 0.78rem;
      font-family: inherit;
      cursor: pointer;
      border: 1px solid transparent;
      transition:
        background 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease;
    }

    .tpd-btn--secondary {
      background: transparent;
      border-color: var(--t-border-subtle, #00ff4122);
      color: color-mix(in srgb, var(--t-fg, #00ff41) 85%, transparent);
    }

    .tpd-btn--secondary:hover {
      background: var(--t-hover-bg, #00ff4115);
      border-color: var(--t-border, #00ff4133);
      color: var(--t-fg, #00ff41);
    }

    .tpd-btn--primary {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 18%, var(--t-bg-deep, #060a06));
      border-color: color-mix(in srgb, var(--t-primary, #00ff41) 55%, transparent);
      color: var(--t-primary, #00ff41);
    }

    .tpd-btn--primary:hover {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 28%, var(--t-bg-deep, #060a06));
    }

    .tpd-btn--primary.tpd-btn--warning {
      border-color: color-mix(in srgb, var(--t-warn, #e8b931) 65%, transparent);
      color: var(--t-warn, #e8b931);
      background: color-mix(in srgb, var(--t-warn, #e8b931) 14%, var(--t-bg-deep, #060a06));
    }

    .tpd-btn--primary.tpd-btn--warning:hover {
      background: color-mix(in srgb, var(--t-warn, #e8b931) 22%, var(--t-bg-deep, #060a06));
    }
  `,
})
export class ThemedPromptDialogComponent {
  protected readonly dialog = inject(ThemedPromptDialogService);
  private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('input');

  /** Local editable copy of the active prompt's value. */
  protected value = signal('');

  constructor() {
    // Whenever a new prompt becomes active, seed the local value and focus the input.
    effect(() => {
      const req = this.dialog.active();
      if (!req) {
        return;
      }
      this.value.set(req.value ?? '');
      // The input is rendered by an @if on dialog.active(); defer focus until
      // after Angular flushes the DOM (next animation frame, post-CD).
      requestAnimationFrame(() => this.focusAndSelect());
    });
  }

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.active()) {
      ev.preventDefault();
      this.onCancel();
    }
  }

  protected onBackdrop(_ev: MouseEvent): void {
    // Ignore backdrop clicks so the user must explicitly Cancel or Escape.
  }

  protected onConfirm(): void {
    const v = (this.value() ?? '').trim();
    this.dialog.close(v);
    this.value.set('');
  }

  protected onCancel(): void {
    this.dialog.close(null);
    this.value.set('');
  }

  private focusAndSelect(): void {
    const el = this.inputRef()?.nativeElement;
    if (!el) {
      return;
    }
    el.focus();
    el.select();
  }
}
