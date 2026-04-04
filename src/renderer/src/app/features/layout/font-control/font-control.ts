import { Component, model, ViewEncapsulation } from '@angular/core';
import { DecimalPipe } from '@angular/common';

const MIN_SIZE = 0.6;
const MAX_SIZE = 1.6;
const STEP = 0.1;

@Component({
  selector: 'app-font-control',
  imports: [DecimalPipe],
  templateUrl: './font-control.html',
  styleUrl: './font-control.css',
  encapsulation: ViewEncapsulation.None
})
export class FontControl {
  readonly fontSize = model(0.9);

  decrease(): void {
    const next = Math.max(MIN_SIZE, +(this.fontSize() - STEP).toFixed(1));
    this.fontSize.set(next);
  }

  increase(): void {
    const next = Math.min(MAX_SIZE, +(this.fontSize() + STEP).toFixed(1));
    this.fontSize.set(next);
  }

  reset(): void {
    this.fontSize.set(0.9);
  }
}
