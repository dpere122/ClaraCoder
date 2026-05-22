import { ipcRenderer } from 'electron';
import type { WorkspaceContextSyncExtras, WorkspaceFileWriteOptions } from '../../shared';

/** Workspace file tree, Monaco unsaved paths, and Python interpreter IPC. */
export const workspaceApi = {
  writeWorkspaceFile: (
    workspaceRoot: string,
    relativePath: string,
    content: string,
    options?: WorkspaceFileWriteOptions,
  ) => ipcRenderer.invoke('write-workspace-file', workspaceRoot, relativePath, content, options),
  createWorkspaceFile: (workspaceRoot: string, absoluteParentDir: string, fileName: string) =>
    ipcRenderer.invoke('create-workspace-file', workspaceRoot, absoluteParentDir, fileName),
  createWorkspaceFolder: (workspaceRoot: string, absoluteParentDir: string, folderName: string) =>
    ipcRenderer.invoke('create-workspace-folder', workspaceRoot, absoluteParentDir, folderName),
  deleteWorkspaceEntry: (workspaceRoot: string, absolutePath: string) =>
    ipcRenderer.invoke('delete-workspace-entry', workspaceRoot, absolutePath),
  renameWorkspaceEntry: (workspaceRoot: string, absolutePath: string, newName: string) =>
    ipcRenderer.invoke('rename-workspace-entry', workspaceRoot, absolutePath, newName),
  readWorkspaceFile: (workspaceRoot: string, relativePath: string) =>
    ipcRenderer.invoke('read-workspace-file', workspaceRoot, relativePath),
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('read-directory', dirPath),
  readDirectoryRecursive: (dirPath: string) => ipcRenderer.invoke('read-directory-recursive', dirPath),
  setWorkspaceContext: (
    sessionId: string,
    workspacePath: string,
    workspaceContext: string,
    extras?: WorkspaceContextSyncExtras,
  ) => ipcRenderer.invoke('set-workspace-context', sessionId, workspacePath, workspaceContext, extras),
  listPythonInterpreters: (sessionId: string) => ipcRenderer.invoke('list-python-interpreters', sessionId),
  applyWorkspacePythonInterpreter: (payload: {
    workspaceId: string;
    sessionId: string;
    interpreterId: string;
  }) => ipcRenderer.invoke('apply-workspace-python-interpreter', payload),
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addWorkspace: (name: string, p: string) => ipcRenderer.invoke('add-workspace', name, p),
  removeWorkspace: (id: string) => ipcRenderer.invoke('remove-workspace', id),
  getWorkspaceMonacoUnsavedPaths: () => ipcRenderer.invoke('get-workspace-monaco-unsaved-paths'),
  setCurrentWorkspace: (id: string | null) => ipcRenderer.invoke('set-current-workspace', id),
  reportWorkspaceMonacoUnsavedPaths: (paths: string[]) => ipcRenderer.send('workspace-monaco-unsaved-paths', paths),
  getCurrentWorkspace: () => ipcRenderer.invoke('get-current-workspace'),
  onWorkspaceChanged: (callback: (event: unknown, workspaceId: string | null) => void) =>
    ipcRenderer.on('workspace-changed', callback),
  onWorkspaceFilesChanged: (callback: (event: unknown, data: unknown) => void) =>
    ipcRenderer.on('workspace-files-changed', callback),
  onOpenWorkspace: (callback: (event: unknown, p: string) => void) => ipcRenderer.on('open-workspace', callback),
  workspacePtySpawn: (workspaceRoot: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke('workspace-pty-spawn', workspaceRoot, cwd, cols, rows),
  workspacePtyWrite: (sessionId: string, data: string) => ipcRenderer.invoke('workspace-pty-write', sessionId, data),
  workspacePtyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('workspace-pty-resize', sessionId, cols, rows),
  workspacePtyKill: (sessionId: string) => ipcRenderer.invoke('workspace-pty-kill', sessionId),
  workspacePtyKillAll: () => ipcRenderer.invoke('workspace-pty-kill-all'),
  onWorkspacePtyData: (
    callback: (event: unknown, data: { sessionId: string; data: string }) => void,
  ) => ipcRenderer.on('workspace-pty-data', callback),
  onWorkspacePtyExit: (
    callback: (
      event: unknown,
      data: { sessionId: string; exitCode: number; signal: number | null },
    ) => void,
  ) => ipcRenderer.on('workspace-pty-exit', callback),
};
