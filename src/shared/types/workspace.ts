/**
 * Reserved app-data id for the no-workspace (general) system prompt.
 * Not a real workspace — storage lives under `workspaces/{id}/system-prompt.md`.
 */
export const NO_WORKSPACE_SYSTEM_PROMPT_ID = '__no_workspace__';

export function isNoWorkspaceSystemPromptId(workspaceId: string | null | undefined): boolean {
  const wid = (workspaceId ?? '').trim();
  return !wid || wid === NO_WORKSPACE_SYSTEM_PROMPT_ID;
}

/** Map a real workspace id, or empty/null (no workspace), to the managed prompt storage id. */
export function resolveSystemPromptStorageId(workspaceId: string | null | undefined): string {
  const wid = (workspaceId ?? '').trim();
  return wid || NO_WORKSPACE_SYSTEM_PROMPT_ID;
}

/**
 * Workspace record persisted in app config and used for filesystem roots.
 * Shared between main process, preload bridge typings, and the Angular renderer.
 *
 * Theming is app-wide (`AppConfig.themeId`), not per-workspace.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /** ISO timestamp of the last time this workspace was selected (Open Recent / switch). */
  lastOpenedAt?: string;
  /** When true, listed in Favorites above last-opened recents. */
  favorite?: boolean;
  /** Sort rank among favorites (lower first). Only meaningful when `favorite` is true. */
  favoriteOrder?: number;
  /**
   * Stable id from Python discovery (`runtime-venv`, `app-backend`, `dot-venv`, …);
   * drives Python LSP analysis env. Empty/unset → app default (`runtime-venv` when installed).
   */
  pythonInterpreterId?: string;
  /**
   * Basename of the file last copied into the managed app-data system prompt
   * (`workspaces/{id}/system-prompt.md`). Display only; content lives in app data.
   */
  systemPromptSourceName?: string;
}

/** Titlebar / native File menu actions sent from main to the renderer. */
export type MenuFileCommandAction =
  | 'open-folder'
  | 'open-recent'
  | 'close-workspace'
  | 'new-file'
  | 'new-folder'
  | 'new-agent'
  | 'new-terminal'
  | 'exit';

export interface MenuFileCommand {
  action: MenuFileCommandAction;
  workspaceId?: string;
}

function workspaceOpenedStampMs(ws: Workspace): number {
  const raw = ws.lastOpenedAt || ws.createdAt;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/** Newest last-opened (or created) first — used by File → Open Recent. */
export function sortRecentWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => {
    const diff = workspaceOpenedStampMs(b) - workspaceOpenedStampMs(a);
    if (diff !== 0) {
      return diff;
    }
    return a.name.localeCompare(b.name);
  });
}

export function isFavoriteWorkspace(ws: Workspace): boolean {
  return ws.favorite === true;
}

function stripFavoriteFields(ws: Workspace): Workspace {
  const next = { ...ws };
  delete next.favorite;
  delete next.favoriteOrder;
  return next;
}

/** Favorites first by `favoriteOrder`, then name. */
export function sortFavoriteWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter(isFavoriteWorkspace).sort((a, b) => {
    const ao = a.favoriteOrder ?? Number.POSITIVE_INFINITY;
    const bo = b.favoriteOrder ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) {
      return ao - bo;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Recents excluding favorites, newest last-opened first. */
export function sortNonFavoriteWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return sortRecentWorkspaces(workspaces.filter((ws) => !isFavoriteWorkspace(ws)));
}

export function setWorkspaceFavorite(
  workspaces: readonly Workspace[],
  id: string,
  favorite: boolean,
): Workspace[] {
  const current = workspaces.find((ws) => ws.id === id);
  if (!current) {
    return [...workspaces];
  }
  if (isFavoriteWorkspace(current) === favorite) {
    return [...workspaces];
  }
  if (!favorite) {
    return compactFavoriteOrders(workspaces.map((ws) => (ws.id === id ? stripFavoriteFields(ws) : ws)));
  }
  const maxOrder = workspaces
    .filter(isFavoriteWorkspace)
    .reduce((max, ws) => Math.max(max, ws.favoriteOrder ?? 0), -1);
  return workspaces.map((ws) =>
    ws.id === id ? { ...ws, favorite: true, favoriteOrder: maxOrder + 1 } : ws,
  );
}

export function compactFavoriteOrders(workspaces: readonly Workspace[]): Workspace[] {
  const order = new Map(sortFavoriteWorkspaces(workspaces).map((ws, index) => [ws.id, index]));
  return workspaces.map((ws) => {
    const rank = order.get(ws.id);
    if (rank === undefined) {
      return isFavoriteWorkspace(ws) || ws.favoriteOrder !== undefined ? stripFavoriteFields(ws) : ws;
    }
    return { ...ws, favorite: true, favoriteOrder: rank };
  });
}

/** Persist a new favorites order. Unknown ids are ignored; omitted current favorites are unstarred. */
export function reorderFavoriteWorkspaces(
  workspaces: readonly Workspace[],
  orderedFavoriteIds: readonly string[],
): Workspace[] {
  const known = new Set(workspaces.map((ws) => ws.id));
  const ids = orderedFavoriteIds.filter((id, index) => known.has(id) && orderedFavoriteIds.indexOf(id) === index);
  const idSet = new Set(ids);
  return workspaces.map((ws) => {
    if (idSet.has(ws.id)) {
      return { ...ws, favorite: true, favoriteOrder: ids.indexOf(ws.id) };
    }
    if (isFavoriteWorkspace(ws) || ws.favoriteOrder !== undefined) {
      return stripFavoriteFields(ws);
    }
    return ws;
  });
}

/** Compact last-opened label for the welcome recents list. */
export function formatWorkspaceLastOpenedLabel(ws: Workspace, nowMs = Date.now()): string {
  const raw = ws.lastOpenedAt || ws.createdAt;
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) {
    return '';
  }
  const diff = nowMs - stamp;
  if (diff < 45_000) {
    return 'Just now';
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'Yesterday';
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
