import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { SidecarStartupState } from '@shared/index';
import { ElectronService } from './electron.service';

/**
 * Whether the Python sidecar is still booting (app launch, or the restart after a Kokoro or
 * Whisper install). The shell holds workspace entry and the chat panel back while it is.
 */
@Injectable({ providedIn: 'root' })
export class SidecarStatusService {
  private readonly electron = inject(ElectronService);

  /** Assumed `starting` in the app until the main process answers: launch is when it matters. */
  readonly state = signal<SidecarStartupState>(this.electron.isElectron ? 'starting' : 'ready');
  readonly loading = computed(() => this.state() === 'starting');

  constructor() {
    if (!this.electron.isElectron) {
      return;
    }
    let pushed = false;
    const off = this.electron.onSidecarStartupState((state) => {
      pushed = true;
      this.state.set(state);
    });
    inject(DestroyRef).onDestroy(off);
    void this.electron
      .sidecarStartupState()
      .catch((): SidecarStartupState => 'ready')
      .then((state) => {
        // A push that arrived while asking is newer than the answer.
        if (!pushed) {
          this.state.set(state);
        }
      });
  }
}
