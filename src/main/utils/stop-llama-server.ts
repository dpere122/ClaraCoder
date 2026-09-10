/**
 * Stop a managed ``llama-server`` so CUDA and host allocations are released.
 *
 * ``taskkill /F`` and Node ``ChildProcess.kill()`` on Windows are
 * ``TerminateProcess``. That skips llama-server's console handler, so
 * ``llama_backend_free()`` never runs and the NVIDIA driver can keep the
 * pinned system RAM after the process is gone.
 *
 * llama-server only starts that cleanup on ``CTRL_C_EVENT`` (Windows) or
 * ``SIGTERM`` (POSIX). Force-kill is the fallback if it does not exit in time.
 */
import { spawnSync, type ChildProcess } from 'child_process';
import { childHasExited, killPidTree, processImageName } from './kill-process-tree';

/** How long to wait for a clean exit before ``TerminateProcess``. */
let stopGraceMs = 15_000;

export function setLlamaServerStopGraceMs(ms: number): void {
  stopGraceMs = Math.max(0, ms);
}

export function getLlamaServerStopGraceMs(): number {
  return stopGraceMs;
}

export type LlamaStopResult = 'exited' | 'graceful' | 'forced';

function isLiveLlamaServer(pid: number): boolean {
  const image = processImageName(pid);
  return !!image && image.includes('llama-server');
}

function sleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitUntilGone(pid: number, graceMs: number, stillRunning: (pid: number) => boolean): boolean {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (!stillRunning(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    sleepMs(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Deliver the one interrupt llama-server treats as a clean shutdown.
 * A second CTRL_C makes it ``exit(1)`` without freeing the backend, so this
 * must be sent only once.
 */
export function signalLlamaServerShutdown(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === 'win32') {
    return signalWindowsConsoleCtrlC(pid);
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

function signalWindowsConsoleCtrlC(pid: number): boolean {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClaraConsoleCtrl {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
}
"@
[void][ClaraConsoleCtrl]::FreeConsole()
if (-not [ClaraConsoleCtrl]::AttachConsole(${pid})) { exit 2 }
[void][ClaraConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not [ClaraConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }
exit 0
`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 8000, encoding: 'utf8' },
  );
  return !r.error && r.status === 0;
}

/**
 * Hide the console window created so Windows can deliver CTRL_C.
 * ``windowsHide: true`` would also set CREATE_NO_WINDOW and make that signal impossible.
 */
export function hideWindowsConsoleWindow(pid: number | undefined): void {
  if (process.platform !== 'win32' || pid == null || pid <= 0) {
    return;
  }
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClaraHideConsole {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public static void Hide(uint target) {
    EnumWindows((hWnd, lParam) => {
      uint wpid;
      GetWindowThreadProcessId(hWnd, out wpid);
      if (wpid == target) { ShowWindow(hWnd, 0); }
      return true;
    }, IntPtr.Zero);
  }
}
"@
[ClaraHideConsole]::Hide(${pid})
`;
  try {
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 4000 },
    );
  } catch {
    /* best-effort; a visible console is preferable to a leaked CUDA context */
  }
}

export function stopLlamaServerPid(pid: number, opts?: { knownOwned?: boolean }): LlamaStopResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'exited';
  }
  // Orphan reaping must not kill a recycled PID. A process we just spawned is
  // stopped even if the image lookup fails, otherwise a tasklist glitch leaves
  // the CUDA context alive.
  if (!opts?.knownOwned && !isLiveLlamaServer(pid)) {
    return 'exited';
  }
  signalLlamaServerShutdown(pid);
  const stillRunning = opts?.knownOwned ? pidExists : isLiveLlamaServer;
  if (waitUntilGone(pid, stopGraceMs, stillRunning)) {
    return 'graceful';
  }
  if (!opts?.knownOwned && !isLiveLlamaServer(pid)) {
    return 'graceful';
  }
  killPidTree(pid);
  return 'forced';
}

export function stopLlamaServerChild(proc: ChildProcess | undefined | null): LlamaStopResult {
  if (!proc?.pid || childHasExited(proc)) {
    return 'exited';
  }
  return stopLlamaServerPid(proc.pid, { knownOwned: true });
}
