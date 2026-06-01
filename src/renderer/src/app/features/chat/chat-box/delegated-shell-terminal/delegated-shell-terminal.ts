import {
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { terminalTailPreview } from '@shared/index';
import { AnsiTerminalPreComponent } from '../../../../core/ansi-terminal-pre';

export type DelegatedShellTerminalDisplayMode = 'preview' | 'full';

@Component({
  selector: 'app-delegated-shell-terminal',
  standalone: true,
  imports: [AnsiTerminalPreComponent],
  templateUrl: './delegated-shell-terminal.html',
  styleUrl: './delegated-shell-terminal.css',
  encapsulation: ViewEncapsulation.None,
})
export class DelegatedShellTerminalComponent {
  readonly label = input<string>('Tool output');
  readonly text = input.required<string>();
  readonly runComplete = input(false);
  readonly exitCode = input<number | null | undefined>(undefined);
  readonly outcome = input<'passed' | 'failed' | undefined>(undefined);
  readonly displayMode = input<DelegatedShellTerminalDisplayMode>('full');

  private readonly terminalBody = viewChild<ElementRef<HTMLElement>>('terminalBody');

  readonly renderText = computed(() => {
    const raw = this.text();
    if (this.displayMode() === 'preview') {
      return terminalTailPreview(raw, 4);
    }
    return raw;
  });

  constructor() {
    effect(() => {
      this.text();
      this.displayMode();
      this.runComplete();
      untracked(() => {
        queueMicrotask(() => this.scrollBodyToBottom());
      });
    });
  }

  private scrollBodyToBottom(): void {
    const el = this.terminalBody()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  badgeClass(): string {
    if (!this.runComplete()) {
      return 'terminal-shell-badge terminal-shell-badge-running';
    }
    const verdict = this.outcome();
    if (verdict === 'passed') {
      return 'terminal-shell-badge terminal-shell-badge-complete';
    }
    if (verdict === 'failed') {
      return 'terminal-shell-badge terminal-shell-badge-error';
    }
    const ec = this.exitCode();
    if (ec !== null && ec !== undefined && ec !== 0) {
      return 'terminal-shell-badge terminal-shell-badge-error';
    }
    return 'terminal-shell-badge terminal-shell-badge-complete';
  }

  badgeText(): string {
    if (!this.runComplete()) {
      return 'Running';
    }
    const verdict = this.outcome();
    if (verdict === 'passed') {
      return 'Passed';
    }
    if (verdict === 'failed') {
      return 'Failed';
    }
    const ec = this.exitCode();
    if (ec === null || ec === undefined) {
      return 'Complete';
    }
    if (ec === 0) {
      return 'Exit 0';
    }
    return `Exit ${ec}`;
  }
}
