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
  dependenciesWindow: null as BrowserWindow | null,
  pythonProcess: null as ChildProcess | null,
  activeConversationId: null as string | null,
  activeConversationWorkspaceId: null as string | null,
  activeWorkspaceWatcher: null as WorkspaceWatcherState | null,
  activeProcesses: new Map<string, ScriptProcess>(),
  /** Relative paths with unsaved edits in the main window workspace Monaco editor (main window only). */
  monacoWorkspaceUnsavedPaths: [] as string[],
  /** One-shot TTS payloads for `nemo-tts://` stream URLs (WAV from local Kokoro). */
  ttsStreamTokens: new Map<string, { text: string; voice: string; speed: number; instructions?: string }>(),
  /**
   * Active TTS fetch abort handles (`ipc:<seq>` from renderer, `proto:<token>` from `nemo-tts://`).
   * Multiple IPC streams may run concurrently so the next chunk can prefetch while the current plays.
   */
  ttsStreamControllers: new Map<string, AbortController>(),
  /** Per session: last workspace path/id synced to Python (conversation resync within same workspace). */
  sessionWorkspaceContextSync: new Map<string, { workspaceId: string; workspacePath: string }>(),
};

/** Abort every in-flight TTS HTTP fetch (IPC streams and `nemo-tts://` protocol). */
export function abortAllTtsStreamControllers(): void {
  for (const c of mainState.ttsStreamControllers.values()) {
    c.abort();
  }
  mainState.ttsStreamControllers.clear();
}
