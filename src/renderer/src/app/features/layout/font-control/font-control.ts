import { Component, input, model, ViewEncapsulation } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';

const DEFAULT_MIN_SIZE = 0.6;
const DEFAULT_MAX_SIZE = 1.6;
const DEFAULT_STEP = 0.1;
const DEFAULT_RESET = 0.9;

@Component({
  selector: 'app-font-control',
  imports: [DecimalPipe, LucideAngularModule],
  templateUrl: './font-control.html',
  styleUrl: './font-control.css',
  encapsulation: ViewEncapsulation.None
})
export class FontControl {
  readonly fontSize = model(0.9);
  readonly minSize = input(DEFAULT_MIN_SIZE);
  readonly maxSize = input(DEFAULT_MAX_SIZE);
  readonly step = input(DEFAULT_STEP);
  readonly defaultSize = input(DEFAULT_RESET);

  decrease(): void {
    const next = Math.max(this.minSize(), +(this.fontSize() - this.step()).toFixed(1));
    this.fontSize.set(next);
  }

  increase(): void {
    const next = Math.min(this.maxSize(), +(this.fontSize() + this.step()).toFixed(1));
    this.fontSize.set(next);
  }

  reset(): void {
    this.fontSize.set(this.defaultSize());
  }
}
