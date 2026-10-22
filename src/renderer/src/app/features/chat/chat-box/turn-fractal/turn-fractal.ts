import { Component, ViewEncapsulation, computed, input } from '@angular/core';
import { turnFractal, type FractalKind } from './turn-fractal-geometry';

/**
 * The turn fractal for one activity block: a shape grown from the block's tool calls in order
 * (see {@link turnFractal}). Each new step fades in; while the stretch is working its newest
 * growth keeps breathing. Takes the theme's colours and sizes to its host.
 */
@Component({
  selector: 'app-turn-fractal',
  standalone: true,
  template: `
    @let f = fractal();
    <svg
      class="turn-fractal"
      [class.turn-fractal--live]="live()"
      [attr.viewBox]="f.viewBox"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path class="turn-fractal__line" [attr.d]="f.base.line" />
      <path class="turn-fractal__third" [attr.d]="f.base.third" />
      <path class="turn-fractal__hi" [attr.d]="f.base.hi" />
      <path class="turn-fractal__dots" [attr.d]="f.base.dots" />
      <!-- Alternating class names restart the fade-in each time a step lands. -->
      <g [class]="f.steps % 2 ? 'turn-fractal__new turn-fractal__new--a' : 'turn-fractal__new turn-fractal__new--b'">
        <path class="turn-fractal__line" [attr.d]="f.newest.line" />
        <path class="turn-fractal__third" [attr.d]="f.newest.third" />
        <path class="turn-fractal__hi" [attr.d]="f.newest.hi" />
        <path class="turn-fractal__dots" [attr.d]="f.newest.dots" />
      </g>
    </svg>
  `,
  styleUrl: './turn-fractal.css',
  encapsulation: ViewEncapsulation.None,
})
export class TurnFractalComponent {
  /** The block's steps, in the order they ran. */
  readonly kinds = input.required<readonly FractalKind[]>();
  /** The stretch is still being worked on. */
  readonly live = input(false);

  readonly fractal = computed(() => turnFractal(this.kinds()));
}
