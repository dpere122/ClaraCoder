import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-health-metrics-toggle',
  templateUrl: './health-metrics-toggle.html',
  styleUrl: './health-metrics-toggle.css',
})
export class HealthMetricsToggle {
  readonly enabled = input(false);
  readonly changed = output<boolean>();

  protected onToggle(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.changed.emit(Boolean(input?.checked));
  }
}
