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
          data-theme-group="dialogs.prompt"
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="'tpd-title'"
          (click)="$event.stopPropagation()"
        >
          <div class="tpd-header">
            <h2 class="tpd-title" id="tpd-title">{{ req.title }}</h2>
            <button type="button" class="tpd-close" aria-label="Close" title="Close" (click)="onCancel()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
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
  /* Same flat IDE dialog as the confirm dialog, with one text field above the buttons. */
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
      background: color-mix(in srgb, var(--t-bg-deep, #020402) 72%, transparent);
    }

    .tpd-panel {
      width: min(26rem, 100%);
      max-height: min(80vh, 100%);
      overflow: auto;
      box-sizing: border-box;
      border: 1px solid var(--t-border, #00ff4133);
      background: var(--t-bg-surface, #0d1a0d);
      color: var(--t-fg, #00ff41);
      box-shadow: var(--t-elev-shadow, 0 10px 28px rgba(0, 0, 0, 0.45));
      font-family: var(--t-font-mono, monospace);
    }

    .tpd-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.5rem 0.35rem 0.9rem;
    }

    .tpd-title {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--t-fg, #00ff41);
    }

    .tpd-close {
      display: inline-grid;
      flex-shrink: 0;
      place-items: center;
      width: 1.55rem;
      height: 1.55rem;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--t-text-muted, #00ff4155);
      cursor: pointer;
    }

    .tpd-close:hover {
      background: var(--t-hover-bg, #00ff4115);
      color: var(--t-fg, #00ff41);
    }

    .tpd-message {
      margin: 0;
      padding: 0 0.9rem 0.6rem;
      font-size: 0.78rem;
      line-height: 1.5;
      color: var(--t-text-muted, #00ff4199);
    }

    .tpd-input {
      display: block;
      width: calc(100% - 1.8rem);
      box-sizing: border-box;
      margin: 0 0.9rem;
      height: 1.75rem;
      padding: 0 0.6rem;
      border: 1px solid var(--t-border, #00ff4133);
      background: var(--t-bg-deep, #060a06);
      color: var(--t-fg, #00ff41);
      font-family: inherit;
      font-size: 0.8rem;
      outline: none;
    }

    .tpd-input:focus {
      border-color: var(--t-primary, #00ff41);
    }

    .tpd-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.4rem;
      padding: 0.75rem 0.9rem 0.8rem;
    }

    .tpd-btn {
      min-height: 1.65rem;
      padding: 0 0.8rem;
      font-size: 0.78rem;
      font-family: inherit;
      cursor: pointer;
      border: 1px solid transparent;
      transition:
        background 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease;
    }

    .tpd-btn:focus-visible {
      outline: 1px solid var(--t-primary, #00ff41);
      outline-offset: 1px;
    }

    .tpd-btn--secondary {
      background: transparent;
      border-color: var(--t-border, #00ff4133);
      color: var(--t-fg, #00ff41);
    }

    .tpd-btn--secondary:hover {
      background: var(--t-hover-bg, #00ff4115);
    }

    .tpd-btn--primary {
      background: var(--t-primary, #00ff41);
      border-color: var(--t-primary, #00ff41);
      color: var(--t-on-primary, #060a06);
      font-weight: 600;
    }

    .tpd-btn--primary:hover {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 85%, var(--t-fg, #fff));
    }

    .tpd-btn--primary.tpd-btn--warning {
      background: var(--t-danger, #ff6b6b);
      border-color: var(--t-danger, #ff6b6b);
      color: var(--t-on-primary, #060a06);
    }

    .tpd-btn--primary.tpd-btn--warning:hover {
      background: color-mix(in srgb, var(--t-danger, #ff6b6b) 85%, var(--t-fg, #fff));
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
