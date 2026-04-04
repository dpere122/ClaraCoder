/** Single directory listing entry from `read-directory` IPC. */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Notifies the renderer that watched workspace paths changed (debounced). */
export interface WorkspaceFilesChangedMessage {
  workspaceId: string;
  workspacePath: string;
  paths: string[];
  kinds: Array<'created' | 'updated' | 'deleted' | 'renamed' | 'unknown'>;
}
