import { Component } from '@angular/core';

/**
 * Decorative Clara mark that sits inside the tutorial card. Supply accessible instructions
 * separately: it does not receive focus or pointer events.
 */
@Component({
  selector: 'app-tutorial-mascot',
  standalone: true,
  templateUrl: './tutorial-mascot.html',
  styleUrl: './tutorial-mascot.css',
  host: { 'aria-hidden': 'true' },
})
export class TutorialMascotComponent {}
