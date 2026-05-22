import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { assertTrustedMainRenderer } from '../assert-trusted-renderer';
import { mainState, type ScriptProcess } from '../../state';
import { buildScriptLaunchPlan } from '../../utils/script-launch';
import { envForChildProcess } from '../../utils/filter-sensitive-env';

function envForScriptChild(): NodeJS.ProcessEnv {
  return envForChildProcess();
}

/**
 * One-shot script run with timeout, plus interactive PTY-like stdin/stdout streaming.
 */
export function registerScriptsIpc(): void {
  ipcMain.handle('run-script', async (event, script: string, language: string, workspacePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { stdout: '', stderr: 'Forbidden', exitCode: -1 };
    }
    console.log('[Main] run-script called:', { language, workspacePath: workspacePath || '(empty)' });

    return new Promise((resolve) => {
      const { unlink } = require('fs').promises;

      let stdout = '';
      let stderr = '';
      let tempFile: string | null = null;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        resolve(result);
      };

      void (async () => {
        try {
          const launchPlan = await buildScriptLaunchPlan(language, script);
          tempFile = launchPlan.tempFile;

          const options: {
            shell: boolean;
            stdio: ('ignore' | 'pipe')[];
            cwd?: string;
            env: NodeJS.ProcessEnv;
          } = {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: envForScriptChild(),
          };
          if (workspacePath) {
            options.cwd = workspacePath;
          }

          console.log('[Main] Running script from temp file:', tempFile);

          const proc = spawn(launchPlan.shellCmd, launchPlan.shellArgs, options);

          proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
          });

          proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
          });

          proc.on('error', (err) => {
            console.error('[Main] run-script error:', err);
            stderr = err.message;
          });

          proc.on('close', (code) => {
            console.log('[Main] run-script completed with code:', code);
            if (tempFile) {
              unlink(tempFile).catch(() => {});
            }
            finish({ stdout, stderr, exitCode: code });
          });

          timeoutId = setTimeout(() => {
            if (!proc.killed) {
              proc.kill();
              if (tempFile) {
                unlink(tempFile).catch(() => {});
              }
              finish({ stdout, stderr, exitCode: -1, timedOut: true });
            }
          }, 60000);
        } catch (err: unknown) {
          console.error('[Main] run-script setup error:', err);
          const message = err instanceof Error ? err.message : String(err);
          if (tempFile) {
            unlink(tempFile).catch(() => {});
          }
          finish({ stdout: '', stderr: message, exitCode: -1 });
        }
      })();
    });
  });

  ipcMain.handle('run-script-interactive', async (event, script: string, language: string, workspacePath: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { processId: null, success: false, error: 'Forbidden' };
    }
    console.log('[Main] run-script-interactive called:', { language, workspacePath: workspacePath || '(empty)' });

    const { unlink } = require('fs').promises;
    const processId = `script-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let stdout = '';
    let stderr = '';
    let tempFile: string | null = null;

    try {
      const launchPlan = await buildScriptLaunchPlan(language, script);
      tempFile = launchPlan.tempFile;

      const options: {
        shell: boolean;
        stdio: ('pipe' | 'ignore')[];
        cwd?: string;
        env: NodeJS.ProcessEnv;
      } = {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: envForScriptChild(),
      };
      if (workspacePath) {
        options.cwd = workspacePath;
      }

      const proc = spawn(launchPlan.shellCmd, launchPlan.shellArgs, options);

      const scriptProc: ScriptProcess = { proc, stdout, stderr, tempFile };
      mainState.activeProcesses.set(processId, scriptProc);

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        scriptProc.stdout = stdout;
        mainState.mainWindow?.webContents.send('script-output', { processId, type: 'stdout', data: chunk });
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        scriptProc.stderr = stderr;
        mainState.mainWindow?.webContents.send('script-output', { processId, type: 'stderr', data: chunk });
      });

      proc.on('error', (err) => {
        console.error('[Main] run-script-interactive error:', err);
        mainState.mainWindow?.webContents.send('script-output', { processId, type: 'error', data: err.message });
        mainState.mainWindow?.webContents.send('script-complete', { processId, exitCode: -1 });
        mainState.activeProcesses.delete(processId);
      });

      proc.on('close', (code) => {
        console.log('[Main] run-script-interactive completed with code:', code);
        mainState.mainWindow?.webContents.send('script-complete', { processId, exitCode: code });
        if (tempFile) {
          unlink(tempFile).catch(() => {});
        }
        mainState.activeProcesses.delete(processId);
      });

      return { processId, success: true };
    } catch (err: unknown) {
      console.error('[Main] run-script-interactive setup error:', err);
      const message = err instanceof Error ? err.message : String(err);
      if (tempFile) {
        unlink(tempFile).catch(() => {});
      }
      return { processId: null, success: false, error: message };
    }
  });

  ipcMain.handle('send-script-input', async (event, processId: string, input: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false, error: 'Forbidden' };
    }
    const scriptProc = mainState.activeProcesses.get(processId);
    if (!scriptProc || !scriptProc.proc.stdin) {
      return { success: false, error: 'Process not found or stdin not available' };
    }

    try {
      scriptProc.proc.stdin.write(input);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('end-script', async (event, processId: string) => {
    try {
      assertTrustedMainRenderer(event);
    } catch {
      return { success: false, error: 'Forbidden' };
    }
    const scriptProc = mainState.activeProcesses.get(processId);
    if (!scriptProc) {
      return { success: false, error: 'Process not found' };
    }

    try {
      if (!scriptProc.proc.killed) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(scriptProc.proc.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          }).on('error', () => {
            scriptProc.proc.kill();
          });
        } else {
          scriptProc.proc.kill('SIGKILL');
        }
      }

      if (scriptProc.tempFile) {
        require('fs').promises.unlink(scriptProc.tempFile).catch(() => {});
      }
      mainState.mainWindow?.webContents.send('script-complete', { processId, exitCode: -1 });
      mainState.activeProcesses.delete(processId);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });
}
