import { normalizePathSlashes } from '../../utils/workspace-relative-path';

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
