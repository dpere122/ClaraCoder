import {
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_DRAG_MIME,
} from '../../chat/chat-context-bar/chat-context-file';
import {
  canSplit,
  EDITOR_GRID_MAX_COLUMNS,
  EDITOR_GRID_MAX_ROWS,
  type EditorGridLayout,
  type EditorGridSplitSide,
  slotById,
} from './editor-grid-layout';

export type EditorGridDropZone = EditorGridSplitSide | 'center';

export interface EditorGridDragSource {
  slotId: string;
  tabId: string;
}

export interface EditorGridDropAction {
  /** `open` is used for files dragged in from outside the grid (workspace tree). */
  kind: 'split' | 'move' | 'open' | 'noop';
  targetSlotId: string;
  zone: EditorGridDropZone;
  /** Only for `split`. */
  side?: EditorGridSplitSide;
  label: string;
  /** True when an edge zone was requested but the 3x3 cap forced a `move`. */
  limitReached: boolean;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const EDITOR_GRID_EDGE_BAND_MAX_PX = 64;
export const EDITOR_GRID_EDGE_BAND_FRACTION = 0.25;

/** Edge band thickness for a dimension: 25% of the dimension, capped at 64px. */
export function edgeBandPx(dimension: number): number {
  return Math.max(0, Math.min(EDITOR_GRID_EDGE_BAND_MAX_PX, dimension * EDITOR_GRID_EDGE_BAND_FRACTION));
}

/**
 * Which drop zone a pointer at (x, y) hits inside `rect`. Edge bands win over the center;
 * in a corner the nearer edge wins.
 */
export function hotspotForPoint(rect: RectLike, x: number, y: number): EditorGridDropZone {
  const dx = x - rect.left;
  const dy = y - rect.top;
  const bandX = edgeBandPx(rect.width);
  const bandY = edgeBandPx(rect.height);
  const distLeft = dx;
  const distRight = rect.width - dx;
  const distTop = dy;
  const distBottom = rect.height - dy;
  const inLeft = distLeft <= bandX;
  const inRight = distRight <= bandX;
  const inTop = distTop <= bandY;
  const inBottom = distBottom <= bandY;
  if (!inLeft && !inRight && !inTop && !inBottom) {
    return 'center';
  }
  const candidates: Array<{ zone: EditorGridSplitSide; dist: number }> = [];
  if (inLeft) candidates.push({ zone: 'left', dist: distLeft });
  if (inRight) candidates.push({ zone: 'right', dist: distRight });
  if (inTop) candidates.push({ zone: 'top', dist: distTop });
  if (inBottom) candidates.push({ zone: 'bottom', dist: distBottom });
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0]!.zone;
}

const SIDE_LABEL: Record<EditorGridSplitSide, string> = {
  left: 'Split left',
  right: 'Split right',
  top: 'Split up',
  bottom: 'Split down',
};

/** Resolve what dropping `source` on `targetSlotId` at `zone` would do. */
export function dropActionFor(
  layout: EditorGridLayout,
  source: EditorGridDragSource,
  targetSlotId: string,
  zone: EditorGridDropZone,
): EditorGridDropAction {
  const target = slotById(layout, targetSlotId);
  const sourceSlot = slotById(layout, source.slotId);
  if (!target || !sourceSlot) {
    return { kind: 'noop', targetSlotId, zone, label: '', limitReached: false };
  }
  const sameSlot = source.slotId === targetSlotId;
  const sourceIsOnlyTab = sourceSlot.tabs.length === 1;

  if (zone === 'center') {
    if (sameSlot) {
      return { kind: 'noop', targetSlotId, zone, label: '', limitReached: false };
    }
    return { kind: 'move', targetSlotId, zone, label: 'Move here', limitReached: false };
  }

  // Splitting away the only tab of the target slot from itself would just rebuild the same
  // slot beside an empty (collapsed) one: treat as no-op.
  if (sameSlot && sourceIsOnlyTab) {
    return { kind: 'noop', targetSlotId, zone, label: 'Nothing to split', limitReached: false };
  }

  if (!canSplit(layout, targetSlotId, zone)) {
    const limitLabel = `${EDITOR_GRID_MAX_COLUMNS}x${EDITOR_GRID_MAX_ROWS} limit`;
    if (sameSlot) {
      return { kind: 'noop', targetSlotId, zone, label: `Cannot split (${limitLabel})`, limitReached: true };
    }
    return { kind: 'move', targetSlotId, zone, label: `Move here (${limitLabel})`, limitReached: true };
  }

  return { kind: 'split', targetSlotId, zone, side: zone, label: SIDE_LABEL[zone], limitReached: false };
}

/**
 * Resolve what dropping a file from outside the grid (workspace tree) on `targetSlotId` at
 * `zone` would do: open in that slot, or split it when an edge is hit and the cap allows.
 */
export function fileDropActionFor(
  layout: EditorGridLayout,
  targetSlotId: string,
  zone: EditorGridDropZone,
): EditorGridDropAction {
  if (!slotById(layout, targetSlotId)) {
    return { kind: 'noop', targetSlotId, zone, label: '', limitReached: false };
  }
  if (zone === 'center') {
    return { kind: 'open', targetSlotId, zone, label: 'Open here', limitReached: false };
  }
  if (!canSplit(layout, targetSlotId, zone)) {
    const limitLabel = `${EDITOR_GRID_MAX_COLUMNS}x${EDITOR_GRID_MAX_ROWS} limit`;
    return { kind: 'open', targetSlotId, zone, label: `Open here (${limitLabel})`, limitReached: true };
  }
  return { kind: 'split', targetSlotId, zone, side: zone, label: SIDE_LABEL[zone], limitReached: false };
}

/**
 * True when a native drag carries a workspace *file* (not a folder) from the tree / image viewer.
 * `getData` is unavailable during `dragover`, so directories are recognised by the move-only
 * `effectAllowed` that {@link populateWorkspacePathDragData} assigns them.
 */
export function isWorkspaceFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) {
    return false;
  }
  const types = Array.from(dt.types ?? []);
  if (!types.includes(WORKSPACE_TREE_DRAG_MIME)) {
    return false;
  }
  return dt.effectAllowed !== 'move';
}

/** Absolute file path carried by a workspace tree drop, or null for folders / other drags. */
export function workspaceFilePathFromDrop(dt: DataTransfer | null | undefined): string | null {
  if (!isWorkspaceFileDrag(dt) || !dt) {
    return null;
  }
  if (dt.getData(WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME) === '1') {
    return null;
  }
  const raw = dt.getData(WORKSPACE_TREE_DRAG_MIME) || dt.getData('text/plain');
  const first = raw
    .split('\n')
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return first ?? null;
}

/**
 * Cells of a 3x3 mini-diagram for the overlay: which cell(s) are highlighted for the
 * resulting layout. Returns indices 0..8 (row-major) that should be lit.
 */
export function previewCellsForZone(zone: EditorGridDropZone): number[] {
  switch (zone) {
    case 'left':
      return [0, 3, 6];
    case 'right':
      return [2, 5, 8];
    case 'top':
      return [0, 1, 2];
    case 'bottom':
      return [6, 7, 8];
    case 'center':
    default:
      return [4];
  }
}
