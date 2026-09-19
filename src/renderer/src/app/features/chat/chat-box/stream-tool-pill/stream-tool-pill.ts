import { Component, ViewEncapsulation, input, output } from '@angular/core';
import type { ToolTrailPillState } from '@shared/index';

@Component({
  selector: 'app-stream-tool-pill',
  standalone: true,
  templateUrl: './stream-tool-pill.html',
  styleUrl: './stream-tool-pill.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamToolPillComponent {
  readonly name = input.required<string>();
  readonly meta = input('');
  readonly state = input<ToolTrailPillState>('neutral');
  readonly expandable = input(false);
  readonly expanded = input(false);
  readonly live = input(false);
  /** Tool spinner inside the pill while this tool batch is the live preview. */
  readonly spinner = input(false);
  /** Read tools use the book highlighter; write tools use the jot pen. */
  readonly spinnerKind = input<'write' | 'read'>('write');

  readonly toggle = output<void>();

  onClick(): void {
    if (this.expandable()) {
      this.toggle.emit();
    }
  }
}
