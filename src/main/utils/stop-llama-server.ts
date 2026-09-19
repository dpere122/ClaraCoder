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
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { childHasExited, killPidTree, processImageName } from './kill-process-tree';

/** How long to wait for a clean exit before ``TerminateProcess``. */
let stopGraceMs = 15_000;

/** Upper bound for the PowerShell helper that delivers CTRL_C on Windows. */
const WINDOWS_CTRL_C_TIMEOUT_MS = 8000;

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

/**
 * Blocking sleep. Only for the synchronous quit path: on the Electron main
 * thread this freezes every window, so runtime stops use ``sleepMsAsync``.
 */
function sleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepMsAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

async function waitUntilGoneAsync(
  pid: number,
  graceMs: number,
  stillRunning: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (!stillRunning(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleepMsAsync(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Resolve ``true`` when a child we spawned reports ``exit`` within ``graceMs``.
 * Uses the ``exit`` event instead of polling so no ``kill(pid, 0)`` probe can
 * observe a recycled PID and mistake a stranger for our server.
 */
function waitForChildExit(proc: ChildProcess, graceMs: number): Promise<boolean> {
  if (childHasExited(proc)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(childHasExited(proc));
    }, Math.max(0, graceMs));
    proc.once('exit', onExit);
  });
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
  return signalPosixTerm(pid);
}

/**
 * Same as ``signalLlamaServerShutdown`` but never blocks the caller. The
 * Windows path compiles a small C# shim with ``Add-Type``, which takes long
 * enough to be a visible UI hitch when done with ``spawnSync``.
 */
export async function signalLlamaServerShutdownAsync(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === 'win32') {
    return await signalWindowsConsoleCtrlCAsync(pid);
  }
  return signalPosixTerm(pid);
}

function signalPosixTerm(pid: number): boolean {
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

function windowsConsoleCtrlCScript(pid: number): string {
  return `
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
}

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function signalWindowsConsoleCtrlC(pid: number): boolean {
  const r = spawnSync('powershell.exe', powershellArgs(windowsConsoleCtrlCScript(pid)), {
    windowsHide: true,
    timeout: WINDOWS_CTRL_C_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return !r.error && r.status === 0;
}

function signalWindowsConsoleCtrlCAsync(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', powershellArgs(windowsConsoleCtrlCScript(pid)), {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    }, WINDOWS_CTRL_C_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
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

/**
 * Blocking stop. Reserved for ``will-quit``, where Electron gives no chance to
 * await and an unfreed CUDA context outlives the app. Everywhere else use
 * ``stopLlamaServerPidAsync`` so the main thread keeps servicing windows.
 */
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

/** Non-blocking ``stopLlamaServerPid`` for PIDs we did not spawn (orphan reaping). */
export async function stopLlamaServerPidAsync(pid: number): Promise<LlamaStopResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'exited';
  }
  if (!isLiveLlamaServer(pid)) {
    return 'exited';
  }
  await signalLlamaServerShutdownAsync(pid);
  if (await waitUntilGoneAsync(pid, stopGraceMs, isLiveLlamaServer)) {
    return 'graceful';
  }
  if (!isLiveLlamaServer(pid)) {
    return 'graceful';
  }
  killPidTree(pid);
  return 'forced';
}

/** Blocking stop of a child we spawned. Quit path only; see ``stopLlamaServerPid``. */
export function stopLlamaServerChild(proc: ChildProcess | undefined | null): LlamaStopResult {
  if (!proc?.pid || childHasExited(proc)) {
    return 'exited';
  }
  return stopLlamaServerPid(proc.pid, { knownOwned: true });
}

/**
 * Non-blocking stop of a child we spawned. The grace wait rides the child's
 * ``exit`` event, so the event loop stays free while llama-server unloads.
 */
export async function stopLlamaServerChildAsync(proc: ChildProcess | undefined | null): Promise<LlamaStopResult> {
  if (!proc?.pid || childHasExited(proc)) {
    return 'exited';
  }
  const pid = proc.pid;
  await signalLlamaServerShutdownAsync(pid);
  if (await waitForChildExit(proc, stopGraceMs)) {
    return 'graceful';
  }
  killPidTree(pid);
  return 'forced';
}
