import { Component, Input, type OnChanges, type SimpleChanges } from '@angular/core';

/** A point in viewport CSS pixels; the mascot is centered on this point. */
export interface TutorialMascotDestination {
  x: number;
  y: number;
}

/**
 * Decorative guide for the tutorial. Supply accessible instructions separately: the mascot does
 * not receive focus or pointer events. Change `transitionKey` to fade it out of its current location
 * and back in at `destination`; clearing `destination` only fades it out.
 */
@Component({
  selector: 'app-tutorial-mascot',
  standalone: true,
  templateUrl: './tutorial-mascot.html',
  styleUrl: './tutorial-mascot.css',
  host: { 'aria-hidden': 'true' },
})
export class TutorialMascotComponent implements OnChanges {
  /** A null or non-finite destination hides the mascot until the target can be measured. */
  @Input() destination: TutorialMascotDestination | null = null;
  @Input() transitionKey = '';
  /** Scale the decoration for short or narrow viewports. */
  @Input() scale = 1;
  /** A one-shot celebration; toggle false then true to play it again. */
  @Input() celebration = false;

  /** At most one location fading out; a new copy restarts the fade because it is tracked by identity. */
  departures: TutorialMascotDestination[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    const moved = changes['destination'];
    const previous: TutorialMascotDestination | null | undefined = moved ? moved.previousValue : this.destination;
    const left = !!changes['transitionKey'] || (!!moved && !this.validDestination);
    if (left && previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
      this.departures = [{ x: previous.x, y: previous.y }];
    }
  }

  get validDestination(): TutorialMascotDestination | null {
    const point = this.destination;
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }

  get validScale(): number {
    return Number.isFinite(this.scale) ? Math.max(0.4, Math.min(this.scale, 1)) : 1;
  }
}
