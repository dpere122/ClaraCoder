/**
 * Tear down a spawned child and its descendants.
 *
 * Node ``ChildProcess.kill()`` only signals that PID. On Windows that is
 * ``TerminateProcess`` (no tree). On POSIX it is ``SIGTERM``/``SIGKILL`` to one
 * PID. LSP servers, ``run_command`` jobs (``start_new_session=True``), and
 * ``llama-server`` helpers then leak — which is what keeps RAM high after Clara
 * Coder is closed.
 */
import { spawnSync, type ChildProcess } from 'child_process';

export function childHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Kill ``pid`` and, on Windows, every descendant (``taskkill /T``). */
export function killPidTree(pid: number | undefined | null): void {
  if (pid == null || pid <= 0) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        timeout: 8000,
      });
      if (r.error || r.status !== 0) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    } else {
      /**
       * POSIX: ``kill(-pid)`` only works when ``pid`` is a session / process-group
       * leader (spawned with ``detached: true``). Fall back to the lone PID.
       */
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

export function killProcessTree(proc: ChildProcess | undefined | null): void {
  if (!proc || !proc.pid || childHasExited(proc)) {
    return;
  }
  killPidTree(proc.pid);
}
