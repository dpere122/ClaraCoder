import { Component, HostListener, inject } from '@angular/core';
import { ThemedConfirmDialogService } from './themed-confirm-dialog.service';

@Component({
  selector: 'app-themed-confirm-dialog',
  standalone: true,
  template: `
    @if (dialog.active(); as req) {
      <div
        class="tcd-backdrop"
        role="presentation"
        (click)="onBackdrop($event)"
      >
        <div
          class="tcd-panel"
          data-theme-group="dialogs.confirm"
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="'tcd-title'"
          (click)="$event.stopPropagation()"
        >
          <div class="tcd-header">
            <h2 class="tcd-title" id="tcd-title">{{ req.title }}</h2>
            <button type="button" class="tcd-close" aria-label="Close" title="Close" (click)="dialog.close('cancel')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <p class="tcd-message">{{ req.message }}</p>
          @if (req.detail?.trim()) {
            <pre class="tcd-detail">{{ req.detail }}</pre>
          }
          <div class="tcd-actions">
            <button type="button" class="tcd-btn tcd-btn--secondary" (click)="dialog.close('cancel')">
              {{ req.cancelText }}
            </button>
            @if (req.middleText) {
              <button type="button" class="tcd-btn tcd-btn--alternate" (click)="dialog.close('middle')">
                {{ req.middleText }}
              </button>
            }
            <button
              type="button"
              class="tcd-btn tcd-btn--primary"
              [class.tcd-btn--warning]="req.variant === 'warning'"
              (click)="dialog.close('confirm')"
            >
              {{ req.confirmText }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  /*
   * Flat IDE dialog: one surface with a hairline border, a title row with a close button, muted
   * copy, detail on the code background, and small buttons. A `warning` confirm (delete, reset,
   * discard) is filled with the danger colour; a middle choice is an outlined accent button.
   */
  styles: `
    :host {
      display: contents;
    }

    .tcd-backdrop {
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

    .tcd-panel {
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

    .tcd-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.5rem 0.35rem 0.9rem;
    }

    .tcd-title {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--t-fg, #00ff41);
    }

    .tcd-close {
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

    .tcd-close:hover {
      background: var(--t-hover-bg, #00ff4115);
      color: var(--t-fg, #00ff41);
    }

    .tcd-message {
      margin: 0;
      padding: 0 0.9rem 0.6rem;
      font-size: 0.78rem;
      line-height: 1.5;
      color: var(--t-text-muted, #00ff4199);
    }

    .tcd-detail {
      margin: 0 0.9rem 0.25rem;
      padding: 0.45rem 0.65rem;
      border: none;
      background: var(--t-code-bg, var(--t-bg-deep, #060a06));
      color: var(--t-fg, #00ff41);
      font-size: 0.74rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 12rem;
      overflow: auto;
    }

    .tcd-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.4rem;
      padding: 0.75rem 0.9rem 0.8rem;
    }

    .tcd-btn {
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

    .tcd-btn:focus-visible {
      outline: 1px solid var(--t-primary, #00ff41);
      outline-offset: 1px;
    }

    .tcd-btn--secondary {
      background: transparent;
      border-color: var(--t-border, #00ff4133);
      color: var(--t-fg, #00ff41);
    }

    .tcd-btn--secondary:hover {
      background: var(--t-hover-bg, #00ff4115);
    }

    .tcd-btn--alternate {
      background: transparent;
      border-color: var(--t-border, #00ff4133);
      color: var(--t-primary, #00ff41);
    }

    .tcd-btn--alternate:hover {
      background: var(--t-hover-bg, #00ff4115);
    }

    .tcd-btn--primary {
      background: var(--t-primary, #00ff41);
      border-color: var(--t-primary, #00ff41);
      color: var(--t-on-primary, #060a06);
      font-weight: 600;
    }

    .tcd-btn--primary:hover {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 85%, var(--t-fg, #fff));
    }

    .tcd-btn--primary.tcd-btn--warning {
      background: var(--t-danger, #ff6b6b);
      border-color: var(--t-danger, #ff6b6b);
      color: var(--t-on-primary, #060a06);
    }

    .tcd-btn--primary.tcd-btn--warning:hover {
      background: color-mix(in srgb, var(--t-danger, #ff6b6b) 85%, var(--t-fg, #fff));
    }
  `,
})
export class ThemedConfirmDialogComponent {
  protected readonly dialog = inject(ThemedConfirmDialogService);

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.active()) {
      ev.preventDefault();
      this.dialog.close('cancel');
    }
  }

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) {
      this.dialog.close('cancel');
    }
  }
}
