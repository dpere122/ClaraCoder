import { normalizePathSlashes } from '../../utils/workspace-relative-path';

export const LLAMA_SERVER_DOCK_STORAGE_KEY = 'nemo.llamaServerDock';

export type LlamaServerDockSide = 'conversations' | 'workspace';

export interface ChatFileTab {
  relativePath: string;
}

export function chatFileTabId(relativePath: string): string {
  return `file:${normalizePathSlashes(relativePath)}`;
}

export function chatFileTabBasename(relativePath: string): string {
  const n = normalizePathSlashes(relativePath);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

export function readLlamaServerDockFromStorage(): LlamaServerDockSide {
  try {
    if (typeof localStorage === 'undefined') {
      return 'conversations';
    }
    const v = localStorage.getItem(LLAMA_SERVER_DOCK_STORAGE_KEY)?.trim();
    if (v === 'workspace') {
      return 'workspace';
    }
  } catch {
    /* ignore */
  }
  return 'conversations';
}

export function writeLlamaServerDockToStorage(target: LlamaServerDockSide): void {
  try {
    localStorage.setItem(LLAMA_SERVER_DOCK_STORAGE_KEY, target);
  } catch {
    /* ignore */
  }
}
