import type { SidecarStartupState } from '../../shared';
import { mainState } from '../state';

/** `starting` from launch: the main window opens before the sidecar is spawned. */
let state: SidecarStartupState = 'starting';

export function getSidecarStartupState(): SidecarStartupState {
  return state;
}

/** Records the state and tells the main window, which holds the workspace UI back while `starting`. */
export function setSidecarStartupState(next: SidecarStartupState): void {
  if (next === state) return;
  state = next;
  try {
    const win = mainState.mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send('sidecar:startup-state', next);
    }
  } catch {
    /* window closing */
  }
}
