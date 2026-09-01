import type { Workspace } from '../../shared';
import { sortRecentWorkspaces } from '../../shared';
import { loadConfigSync } from '../config/load-save';

export { sortRecentWorkspaces };

/** Registered workspaces newest-first for File → Open Recent. */
export function getRecentWorkspaces(): Workspace[] {
  try {
    return sortRecentWorkspaces(loadConfigSync().workspaces ?? []);
  } catch {
    return [];
  }
}
