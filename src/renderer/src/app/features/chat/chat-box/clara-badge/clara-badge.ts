import { Component, ViewEncapsulation, input } from '@angular/core';

/**
 * Clara's mark beside her name in the transcript: the logo's open C with a dot in its mouth
 * (Orbit). The arc takes the header colour; the dot is the theme's secondary accent and
 * breathes while a reply is streaming.
 */
@Component({
  selector: 'app-clara-badge',
  standalone: true,
  template: `
    <svg
      class="clara-badge"
      [class.clara-badge--live]="live()"
      viewBox="0 0 16 16"
      fill="none"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path class="clara-badge__arc" d="M12.33 4.61A5.5 5.5 0 1 0 12.33 11.39" />
      <circle class="clara-badge__dot" cx="13.6" cy="8" r="1.6" />
    </svg>
  `,
  styleUrl: './clara-badge.css',
  encapsulation: ViewEncapsulation.None,
})
export class ClaraBadgeComponent {
  /** The reply is streaming: the dot breathes. */
  readonly live = input(false);
}
