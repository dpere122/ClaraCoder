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
import * as path from 'path';

export function childHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Lower-cased executable name (no directory) of the process with ``pid``, or ``null``
 * when there is no such process or the lookup failed. Used before reaping PIDs that were
 * persisted by an earlier session: the OS may have recycled the number for an unrelated
 * process, and killing that tree would be destructive.
 */
export function processImageName(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        windowsHide: true,
        timeout: 8000,
        encoding: 'utf8',
      });
      if (r.error || r.status !== 0) {
        return null;
      }
      // Matching row: "llama-server.exe","1234","Console","1","1,234 K". No match prints an
      // INFO sentence instead, which never starts with a quote.
      const row = String(r.stdout ?? '')
        .split(/\r?\n/)
        .find((line) => line.startsWith('"'));
      const image = row?.slice(1).split('","')[0]?.trim();
      return image ? image.toLowerCase() : null;
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 8000, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      return null;
    }
    // Linux prints the bare name; macOS prints the full executable path.
    const name = String(r.stdout ?? '').trim();
    return name ? path.basename(name).toLowerCase() : null;
  } catch {
    return null;
  }
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
