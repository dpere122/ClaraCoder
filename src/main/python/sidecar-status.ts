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

/** Restarts asked for and not yet finished, the running one included. */
let restartsPending = 0;
let restartQueue: Promise<void> = Promise.resolve();

/**
 * Runs a sidecar restart with the state held at `starting`. Restarts run one at a time: a second
 * one started mid-restart would kill the first one's new process, which then reported `failed`
 * while the second was still booting. The state settles on the last restart's outcome.
 */
export function runSidecarRestart(restart: () => Promise<void>): Promise<void> {
  restartsPending += 1;
  setSidecarStartupState('starting');
  const run = restartQueue.then(restart);
  restartQueue = run.catch(() => undefined);
  const settle = (outcome: SidecarStartupState): void => {
    restartsPending -= 1;
    if (restartsPending === 0) {
      setSidecarStartupState(outcome);
    }
  };
  return run.then(
    () => settle('ready'),
    (err: unknown) => {
      settle('failed');
      throw err;
    },
  );
}
