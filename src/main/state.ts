import type { BrowserWindow } from 'electron';
import type { ChildProcess } from 'child_process';
import type { WorkspaceWatcherState } from './workspace/watcher-state';

/**
 * Tracks a subprocess started for interactive script execution (`run-script-interactive` IPC).
 */
export interface ScriptProcess {
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  tempFile: string | null;
}

/**
 * Mutable main-process singletons shared across IPC handlers, windows, and workspace watcher.
 * Using one object avoids non-reassignable `import { x }` bindings across CommonJS modules.
 */
export const mainState = {
  mainWindow: null as BrowserWindow | null,
  settingsWindow: null as BrowserWindow | null,
  healthWindow: null as BrowserWindow | null,
  pythonProcess: null as ChildProcess | null,
  activeConversationId: null as string | null,
  activeConversationWorkspaceId: null as string | null,
  activeWorkspaceWatcher: null as WorkspaceWatcherState | null,
  activeProcesses: new Map<string, ScriptProcess>(),
  /** One-shot TTS payloads for `nemo-tts://` stream URLs (MP3 + MSE quirks in Chromium). */
  ttsStreamTokens: new Map<string, { text: string; voice: string }>(),
  ttsAbort: null as AbortController | null,
};
