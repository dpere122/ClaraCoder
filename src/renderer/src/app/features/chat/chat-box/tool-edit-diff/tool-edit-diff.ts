import { Component, ViewEncapsulation, computed, input } from '@angular/core';
import { parseEditDiff } from '@shared/index';

/** What one edit call changed: its unified diff with old / new line numbers, shown in the expanded edit pill. */
@Component({
  selector: 'app-tool-edit-diff',
  standalone: true,
  templateUrl: './tool-edit-diff.html',
  styleUrl: './tool-edit-diff.css',
  encapsulation: ViewEncapsulation.None,
})
export class ToolEditDiffComponent {
  readonly diff = input.required<string>();
  /** The tool's one-line result (`Updated … · Post-edit checks …`), shown under the diff. */
  readonly result = input('');

  readonly lines = computed(() => parseEditDiff(this.diff()));
}
