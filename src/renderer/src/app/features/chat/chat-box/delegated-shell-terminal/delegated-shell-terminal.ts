import {
  Component,
  ElementRef,
  ViewEncapsulation,
  effect,
  input,
  untracked,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-delegated-shell-terminal',
  standalone: true,
  templateUrl: './delegated-shell-terminal.html',
  styleUrl: './delegated-shell-terminal.css',
  encapsulation: ViewEncapsulation.None,
})
export class DelegatedShellTerminalComponent {
  /** Shown in the summary line and terminal title row. */
  readonly label = input<string>('Tool output');
  /** Full multiplexed stream text (e.g. pytest stdout + prefixed stderr lines). */
  readonly text = input.required<string>();
  /** Whether the subprocess has finished (`tool_exec_complete` or persisted turn). */
  readonly runComplete = input(false);
  /** Exit code when known; omitted before complete or when the backend could not start the process. */
  readonly exitCode = input<number | null | undefined>(undefined);
  /** Smoke-test verdict when a watch process was stopped after readiness/steady state. */
  readonly outcome = input<'passed' | 'failed' | undefined>(undefined);

  private readonly terminalBody = viewChild<ElementRef<HTMLElement>>('terminalBody');

  constructor() {
    effect(() => {
      this.text();
      this.runComplete();
      this.exitCode();
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
