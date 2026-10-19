import { Component, inject } from '@angular/core';
import { ElectronService } from '../../../core/electron.service';
import { HealthRuntimeStore } from '../shared/health-runtime-store';

/** Runtime tab: overall verdict plus one tile per sidecar / dependency / server. */
@Component({
  selector: 'app-health-runtime-status',
  templateUrl: './health-runtime-status.html',
  styleUrls: ['../shared/health-tone.css', './health-runtime-status.css'],
})
export class HealthRuntimeStatus {
  private readonly electron = inject(ElectronService);
  protected readonly runtime = inject(HealthRuntimeStore);

  protected openDependencies(): void {
    this.electron.openDependenciesWindow();
  }
}
