import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Loading spinner: four squares lighting clockwise. One em square in the theme's primary
 * colour, so the host's `font-size` sets its size and `color` its tint.
 */
@Component({
  selector: 'app-grid-spinner',
  template: '<span></span><span></span><span></span><span></span>',
  styleUrl: './grid-spinner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class GridSpinnerComponent {}
