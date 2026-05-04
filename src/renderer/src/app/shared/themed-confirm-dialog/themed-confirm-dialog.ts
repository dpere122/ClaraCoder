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
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="'tcd-title'"
          (click)="$event.stopPropagation()"
        >
          <h2 class="tcd-title" id="tcd-title">{{ req.title }}</h2>
          <p class="tcd-message">{{ req.message }}</p>
          @if (req.detail?.trim()) {
            <pre class="tcd-detail">{{ req.detail }}</pre>
          }
          <div class="tcd-actions">
            <button type="button" class="tcd-btn tcd-btn--secondary" (click)="dialog.close(false)">
              {{ req.cancelText }}
            </button>
            <button
              type="button"
              class="tcd-btn tcd-btn--primary"
              [class.tcd-btn--warning]="req.variant === 'warning'"
              (click)="dialog.close(true)"
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

    .tcd-backdrop {
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

    .tcd-panel {
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

    .tcd-title {
      margin: 0 0 0.65rem;
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--t-fg, #00ff41);
    }

    .tcd-message {
      margin: 0 0 0.75rem;
      font-size: 0.82rem;
      line-height: 1.45;
      color: color-mix(in srgb, var(--t-fg, #00ff41) 92%, transparent);
    }

    .tcd-detail {
      margin: 0 0 1rem;
      padding: 0.55rem 0.65rem;
      border-radius: 4px;
      border: 1px solid var(--t-border-subtle, #00ff4122);
      background: var(--t-bg-deep, #060a06);
      color: var(--t-text-muted, #00ff4155);
      font-size: 0.72rem;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 12rem;
      overflow: auto;
    }

    .tcd-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .tcd-btn {
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

    .tcd-btn--secondary {
      background: transparent;
      border-color: var(--t-border-subtle, #00ff4122);
      color: color-mix(in srgb, var(--t-fg, #00ff41) 85%, transparent);
    }

    .tcd-btn--secondary:hover {
      background: var(--t-hover-bg, #00ff4115);
      border-color: var(--t-border, #00ff4133);
      color: var(--t-fg, #00ff41);
    }

    .tcd-btn--primary {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 18%, var(--t-bg-deep, #060a06));
      border-color: color-mix(in srgb, var(--t-primary, #00ff41) 55%, transparent);
      color: var(--t-primary, #00ff41);
    }

    .tcd-btn--primary:hover {
      background: color-mix(in srgb, var(--t-primary, #00ff41) 28%, var(--t-bg-deep, #060a06));
    }

    .tcd-btn--primary.tcd-btn--warning {
      border-color: color-mix(in srgb, var(--t-warn, #e8b931) 65%, transparent);
      color: var(--t-warn, #e8b931);
      background: color-mix(in srgb, var(--t-warn, #e8b931) 14%, var(--t-bg-deep, #060a06));
    }

    .tcd-btn--primary.tcd-btn--warning:hover {
      background: color-mix(in srgb, var(--t-warn, #e8b931) 22%, var(--t-bg-deep, #060a06));
    }
  `,
})
export class ThemedConfirmDialogComponent {
  protected readonly dialog = inject(ThemedConfirmDialogService);

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.active()) {
      ev.preventDefault();
      this.dialog.close(false);
    }
  }

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) {
      this.dialog.close(false);
    }
  }
}
