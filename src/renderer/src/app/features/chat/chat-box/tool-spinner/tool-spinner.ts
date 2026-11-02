import { Component, ViewEncapsulation, input } from '@angular/core';
import type { SpinnerKind, ToolGlyph } from '../tool-spinner-kind';

/**
 * Live activity spinner, drawn inline so it takes the theme's colours: the line work in
 * `--t-primary`, highlights in `--t-secondary`, and a third tone from `--t-hljs-number`. Draws
 * the turn-activity set or a tool's own {@link ToolGlyph}; `still` freezes a glyph on
 * its icon frame. Sizes to its host; motion stops under reduced motion.
 */
@Component({
  selector: 'app-tool-spinner',
  standalone: true,
  templateUrl: './tool-spinner.html',
  styleUrl: './tool-spinner.css',
  encapsulation: ViewEncapsulation.None,
})
export class ToolSpinnerComponent {
  readonly kind = input.required<SpinnerKind | ToolGlyph>();
  /** Draw without motion: a finished tool's icon. */
  readonly still = input(false);
}
