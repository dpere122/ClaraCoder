import { Component, ViewEncapsulation, computed, input } from '@angular/core';
import { SYNAPSE_HEIGHT, synapseGraph, type SynapseStep } from './turn-synapse-geometry';

/** Rendered height in px; the width follows the graph at the same scale. */
const HEIGHT_PX = 24;

/**
 * The synapse graph for one activity block (see {@link synapseGraph}). While the stretch works,
 * a pulse runs along the newest link and the newest node glows; finished, it holds still. Drawn
 * as vector paths with non-scaling strokes and an integer pixel size, so it stays sharp at any
 * zoom or while panes resize. Takes the theme's colours.
 */
@Component({
  selector: 'app-turn-synapse',
  standalone: true,
  template: `
    @let g = graph();
    <svg
      class="turn-synapse"
      [class.turn-synapse--live]="live()"
      [attr.width]="widthPx()"
      [attr.height]="heightPx"
      [attr.viewBox]="'0 0 ' + g.width + ' ' + viewHeight"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path class="turn-synapse__link" [attr.d]="g.paths.links" />
      <path class="turn-synapse__link turn-synapse__link--arc" [attr.d]="g.paths.arcs" />
      <path class="turn-synapse__stalk" [attr.d]="g.paths.stalks" />
      <path class="turn-synapse__dendrite" [attr.d]="g.paths.dendrites" />
      <path class="turn-synapse__ring" [attr.d]="g.paths.rings" />
      <path class="turn-synapse__pending" [attr.d]="g.paths.pending" />
      <path class="turn-synapse__lookup" [attr.d]="g.paths.lookups" />
      <path class="turn-synapse__node" [attr.d]="g.paths.nodes" />
      <path class="turn-synapse__change" [attr.d]="g.paths.changes" />
      @if (live() && g.columns > 0) {
        <!-- Alternating class names restart the animations each time a column lands. -->
        <circle
          [class]="'turn-synapse__halo turn-synapse__halo--' + tick()"
          [attr.cx]="g.head.x"
          [attr.cy]="g.head.y"
          r="3.6"
        />
        <circle
          [class]="'turn-synapse__pulse turn-synapse__pulse--' + tick()"
          [attr.cx]="g.from.x"
          [attr.cy]="g.from.y"
          r="1.1"
          [style.--dx]="g.head.x - g.from.x + 'px'"
          [style.--dy]="g.head.y - g.from.y + 'px'"
        />
      }
    </svg>
  `,
  styleUrl: './turn-synapse.css',
  encapsulation: ViewEncapsulation.None,
})
export class TurnSynapseComponent {
  /** The block's steps, in the order they ran. */
  readonly steps = input.required<readonly SynapseStep[]>();
  /** The stretch is still being worked on. */
  readonly live = input(false);

  protected readonly heightPx = HEIGHT_PX;
  protected readonly viewHeight = SYNAPSE_HEIGHT;

  readonly graph = computed(() => synapseGraph(this.steps()));
  /** Whole pixels, so the graph never lands on a fractional width and blurs. */
  readonly widthPx = computed(() => Math.round((this.graph().width * HEIGHT_PX) / SYNAPSE_HEIGHT));
  readonly tick = computed(() => (this.graph().columns % 2 ? 'a' : 'b'));
}
