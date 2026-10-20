import { Component, ViewEncapsulation, computed, input, output } from '@angular/core';
import type { ToolTrailPillState } from '@shared/index';
import { toolSpinnerSrc, type ToolSpinnerKind } from '../tool-spinner-kind';

@Component({
  selector: 'app-stream-tool-pill',
  standalone: true,
  templateUrl: './stream-tool-pill.html',
  styleUrl: './stream-tool-pill.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamToolPillComponent {
  readonly name = input.required<string>();
  /** Hover text for the name (defaults to the name itself). */
  readonly nameTitle = input('');
  readonly meta = input('');
  /** Run time after the meta (`1.2s`); empty hides it. */
  readonly duration = input('');
  /** Hover text for the run time. */
  readonly durationTitle = input('');
  /** Long call: the run time reads at full strength instead of muted. */
  readonly durationSlow = input(false);
  readonly state = input<ToolTrailPillState>('neutral');
  readonly expandable = input(false);
  readonly expanded = input(false);
  readonly live = input(false);
  /** Tool spinner inside the pill while this tool batch is the live preview. */
  readonly spinner = input(false);
  /** Book for reads, terminal for commands, globe for web tools, jot pen for everything else. */
  readonly spinnerKind = input<ToolSpinnerKind>('write');

  readonly spinnerSrc = computed(() => toolSpinnerSrc(this.spinnerKind()));

  /** Glow the name letter by letter (like the thinking preview header) while calls are active. */
  readonly shimmer = input(false);
  readonly nameChars = computed(() => Array.from(this.name()));

  readonly toggle = output<void>();

  onClick(): void {
    if (this.expandable()) {
      this.toggle.emit();
    }
  }
}
