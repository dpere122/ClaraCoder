import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_DRAG_MIME,
} from '../../chat/chat-context-bar/chat-context-file';
import { chatFileTabId, workspaceChatFileTab } from '../app-chat-file-tabs';
import {
  dropActionFor,
  edgeBandPx,
  fileDropActionFor,
  hotspotForPoint,
  isWorkspaceFileDrag,
  previewCellsForZone,
  workspaceFilePathFromDrop,
} from './editor-grid-drop';
import { singleSlotLayout, splitSlotWithTab, type EditorGridLayout } from './editor-grid-layout';

function fakeDataTransfer(
  data: Record<string, string>,
  effectAllowed: DataTransfer['effectAllowed'] = 'copyMove',
): DataTransfer {
  return {
    types: Object.keys(data),
    effectAllowed,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

const a = workspaceChatFileTab('a.ts');
const b = workspaceChatFileTab('b.ts');
const c = workspaceChatFileTab('c.ts');
const d = workspaceChatFileTab('d.ts');

function rootSlotId(layout: EditorGridLayout): string {
  return layout.columns[0]!.slots[0]!.id;
}

describe('hotspotForPoint', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 };

  it('caps the edge band at 64px', () => {
    expect(edgeBandPx(400)).toBe(64);
    expect(edgeBandPx(100)).toBe(25);
  });

  it('returns center away from edges', () => {
    expect(hotspotForPoint(rect, 200, 200)).toBe('center');
    expect(hotspotForPoint(rect, 65, 200)).toBe('center');
  });

  it('returns the edge inside its band', () => {
    expect(hotspotForPoint(rect, 10, 200)).toBe('left');
    expect(hotspotForPoint(rect, 390, 200)).toBe('right');
    expect(hotspotForPoint(rect, 200, 10)).toBe('top');
    expect(hotspotForPoint(rect, 200, 390)).toBe('bottom');
  });

  it('prefers the nearer edge in a corner', () => {
    expect(hotspotForPoint(rect, 10, 30)).toBe('left');
    expect(hotspotForPoint(rect, 30, 10)).toBe('top');
  });

  it('accounts for rect offset', () => {
    expect(hotspotForPoint({ left: 100, top: 100, width: 200, height: 200 }, 110, 200)).toBe('left');
  });
});

describe('dropActionFor', () => {
  it('center on another slot is a move', () => {
    let layout = singleSlotLayout([a, b], chatFileTabId(a));
    const left = rootSlotId(layout);
    layout = splitSlotWithTab(layout, left, chatFileTabId(b), left, 'right').layout;
    const right = layout.columns[1]!.slots[0]!.id;
    const action = dropActionFor(layout, { slotId: left, tabId: chatFileTabId(a) }, right, 'center');
    expect(action.kind).toBe('move');
    expect(action.label).toBe('Move here');
  });

  it('center on the same slot is a noop', () => {
    const layout = singleSlotLayout([a, b]);
    const slot = rootSlotId(layout);
    expect(dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(a) }, slot, 'center').kind).toBe('noop');
  });

  it('edge split when allowed', () => {
    const layout = singleSlotLayout([a, b]);
    const slot = rootSlotId(layout);
    const action = dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(a) }, slot, 'right');
    expect(action).toMatchObject({ kind: 'split', side: 'right', label: 'Split right', limitReached: false });
    expect(dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(a) }, slot, 'bottom').label).toBe('Split down');
  });

  it('splitting the only tab of a slot away from itself is a noop', () => {
    const layout = singleSlotLayout([a]);
    const slot = rootSlotId(layout);
    const action = dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(a) }, slot, 'right');
    expect(action.kind).toBe('noop');
  });

  it('degrades to move with a limit label when the 3x3 cap is reached', () => {
    let layout = singleSlotLayout([a, b, c, d]);
    const slot = rootSlotId(layout);
    layout = splitSlotWithTab(layout, slot, chatFileTabId(a), slot, 'right').layout;
    layout = splitSlotWithTab(layout, slot, chatFileTabId(b), slot, 'right').layout;
    expect(layout.columns).toHaveLength(3);
    const farRight = layout.columns[2]!.slots[0]!.id;
    const action = dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(c) }, farRight, 'right');
    expect(action.kind).toBe('move');
    expect(action.limitReached).toBe(true);
    expect(action.label).toBe('Move here (3x3 limit)');
    // Same slot + limit: cannot split, cannot move.
    const same = dropActionFor(layout, { slotId: slot, tabId: chatFileTabId(c) }, slot, 'left');
    expect(same.kind).toBe('noop');
    expect(same.limitReached).toBe(true);
  });

  it('returns noop for unknown slots', () => {
    const layout = singleSlotLayout([a]);
    expect(dropActionFor(layout, { slotId: 'x', tabId: chatFileTabId(a) }, 'y', 'center').kind).toBe('noop');
  });
});

describe('fileDropActionFor', () => {
  it('opens in place on the center zone', () => {
    const layout = singleSlotLayout([a]);
    const slot = rootSlotId(layout);
    expect(fileDropActionFor(layout, slot, 'center')).toMatchObject({ kind: 'open', label: 'Open here' });
  });

  it('splits on an edge when the cap allows, even for a single-tab slot', () => {
    const layout = singleSlotLayout([a]);
    const slot = rootSlotId(layout);
    expect(fileDropActionFor(layout, slot, 'right')).toMatchObject({ kind: 'split', side: 'right', label: 'Split right' });
    expect(fileDropActionFor(layout, slot, 'bottom')).toMatchObject({ kind: 'split', side: 'bottom', label: 'Split down' });
  });

  it('degrades to open-in-place when the 3x3 cap is reached', () => {
    let layout = singleSlotLayout([a, b, c]);
    const slot = rootSlotId(layout);
    layout = splitSlotWithTab(layout, slot, chatFileTabId(a), slot, 'right').layout;
    layout = splitSlotWithTab(layout, slot, chatFileTabId(b), slot, 'right').layout;
    const action = fileDropActionFor(layout, slot, 'left');
    expect(action).toMatchObject({ kind: 'open', limitReached: true, label: 'Open here (3x3 limit)' });
  });

  it('is a noop for unknown slots', () => {
    expect(fileDropActionFor(singleSlotLayout([a]), 'nope', 'center').kind).toBe('noop');
  });
});

describe('isWorkspaceFileDrag / workspaceFilePathFromDrop', () => {
  it('accepts tree file drags and reads the absolute path', () => {
    const dt = fakeDataTransfer({
      [WORKSPACE_TREE_DRAG_MIME]: 'C:/ws/src/a.ts',
      [WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME]: '0',
      'text/plain': 'C:/ws/src/a.ts',
    });
    expect(isWorkspaceFileDrag(dt)).toBe(true);
    expect(workspaceFilePathFromDrop(dt)).toBe('C:/ws/src/a.ts');
  });

  it('rejects folder drags (move-only effect during dragover, directory flag on drop)', () => {
    const moveOnly = fakeDataTransfer({ [WORKSPACE_TREE_DRAG_MIME]: 'C:/ws/src' }, 'move');
    expect(isWorkspaceFileDrag(moveOnly)).toBe(false);
    expect(workspaceFilePathFromDrop(moveOnly)).toBeNull();

    const flagged = fakeDataTransfer({
      [WORKSPACE_TREE_DRAG_MIME]: 'C:/ws/src',
      [WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME]: '1',
    });
    expect(isWorkspaceFileDrag(flagged)).toBe(true);
    expect(workspaceFilePathFromDrop(flagged)).toBeNull();
  });

  it('ignores drags without the workspace mime (plain text, OS files)', () => {
    expect(isWorkspaceFileDrag(fakeDataTransfer({ 'text/plain': 'hello' }))).toBe(false);
    expect(isWorkspaceFileDrag(fakeDataTransfer({ Files: '' }))).toBe(false);
    expect(isWorkspaceFileDrag(null)).toBe(false);
  });
});

describe('previewCellsForZone', () => {
  it('lights the matching band of the 3x3 diagram', () => {
    expect(previewCellsForZone('left')).toEqual([0, 3, 6]);
    expect(previewCellsForZone('right')).toEqual([2, 5, 8]);
    expect(previewCellsForZone('top')).toEqual([0, 1, 2]);
    expect(previewCellsForZone('bottom')).toEqual([6, 7, 8]);
    expect(previewCellsForZone('center')).toEqual([4]);
  });
});
