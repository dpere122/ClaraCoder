import { beforeEach, describe, expect, it } from 'vitest';
import { chatFileTabId, workspaceChatFileTab } from '../app-chat-file-tabs';
import {
  addTabToSlot,
  adjustSizesAtGutter,
  allTabsFlat,
  canSplit,
  collapseEmpty,
  EDITOR_GRID_MAX_COLUMNS,
  EDITOR_GRID_MAX_ROWS,
  findSlot,
  moveTabToSlot,
  removeTabEverywhere,
  removeTabFromSlot,
  reorderTabInSlot,
  resetEditorGridIdSeq,
  resolveFocusedSlotId,
  setActiveTab,
  singleSlotLayout,
  slotCount,
  slotIdsContainingModelKey,
  splitSlotWithNewTab,
  splitSlotWithTab,
  type EditorGridLayout,
} from './editor-grid-layout';

const a = workspaceChatFileTab('src/a.ts');
const b = workspaceChatFileTab('src/b.ts');
const c = workspaceChatFileTab('src/c.ts');
const idA = chatFileTabId(a);
const idB = chatFileTabId(b);

function rootSlotId(layout: EditorGridLayout): string {
  return layout.columns[0]!.slots[0]!.id;
}

describe('editor-grid-layout', () => {
  beforeEach(() => resetEditorGridIdSeq());

  it('creates a single slot layout with last tab active by default', () => {
    const layout = singleSlotLayout([a, b]);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.slots).toHaveLength(1);
    expect(layout.columns[0]!.slots[0]!.activeTabId).toBe(idB);
    expect(layout.columnSizes).toEqual([1]);
  });

  it('adds tabs without duplicating within a slot and activates them', () => {
    let layout = singleSlotLayout([a]);
    const slotId = rootSlotId(layout);
    layout = addTabToSlot(layout, slotId, b);
    layout = addTabToSlot(layout, slotId, a);
    expect(layout.columns[0]!.slots[0]!.tabs).toHaveLength(2);
    expect(layout.columns[0]!.slots[0]!.activeTabId).toBe(idA);
  });

  it('splits right into a new column and moves the tab there', () => {
    let layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    const res = splitSlotWithTab(layout, slotId, idA, slotId, 'right');
    layout = res.layout;
    expect(res.newSlotId).not.toBeNull();
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idB]);
    expect(layout.columns[1]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idA]);
    expect(layout.columns[1]!.slots[0]!.id).toBe(res.newSlotId);
    expect(layout.columnSizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('splits left inserting the new column before the target', () => {
    const layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    const res = splitSlotWithTab(layout, slotId, idA, slotId, 'left');
    expect(res.layout.columns[0]!.slots[0]!.id).toBe(res.newSlotId);
  });

  it('splits down inserting a row in the same column', () => {
    const layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    const res = splitSlotWithTab(layout, slotId, idA, slotId, 'bottom');
    expect(res.layout.columns).toHaveLength(1);
    expect(res.layout.columns[0]!.slots).toHaveLength(2);
    expect(res.layout.columns[0]!.slots[1]!.id).toBe(res.newSlotId);
    expect(res.layout.columns[0]!.rowSizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('splits with a new (external) tab without touching the target slot tabs', () => {
    const layout = singleSlotLayout([a], idA);
    const slotId = rootSlotId(layout);
    const res = splitSlotWithNewTab(layout, slotId, 'right', b);
    expect(res.newSlotId).not.toBeNull();
    expect(res.layout.columns).toHaveLength(2);
    expect(res.layout.columns[0]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idA]);
    expect(res.layout.columns[1]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idB]);
    expect(res.layout.columns[1]!.slots[0]!.activeTabId).toBe(idB);
    expect(res.layout.columnSizes).toEqual([0.5, 0.5]);

    const down = splitSlotWithNewTab(layout, slotId, 'bottom', b);
    expect(down.layout.columns[0]!.slots).toHaveLength(2);
    expect(down.layout.columns[0]!.slots[1]!.id).toBe(down.newSlotId);
  });

  it('splitSlotWithNewTab returns the same layout when the cap is reached', () => {
    let layout = singleSlotLayout([a]);
    const slotId = rootSlotId(layout);
    layout = splitSlotWithNewTab(layout, slotId, 'right', b).layout;
    layout = splitSlotWithNewTab(layout, slotId, 'right', c).layout;
    expect(layout.columns).toHaveLength(EDITOR_GRID_MAX_COLUMNS);
    const blocked = splitSlotWithNewTab(layout, slotId, 'left', workspaceChatFileTab('d.ts'));
    expect(blocked.newSlotId).toBeNull();
    expect(blocked.layout).toBe(layout);
  });

  it('enforces the 3x3 cap', () => {
    let layout = singleSlotLayout([a, b, c, workspaceChatFileTab('d.ts'), workspaceChatFileTab('e.ts')]);
    let slotId = rootSlotId(layout);
    // Two right splits -> 3 columns.
    for (const t of [a, b]) {
      const r = splitSlotWithTab(layout, slotId, chatFileTabId(t), slotId, 'right');
      layout = r.layout;
    }
    expect(layout.columns).toHaveLength(EDITOR_GRID_MAX_COLUMNS);
    expect(canSplit(layout, slotId, 'right')).toBe(false);
    expect(canSplit(layout, slotId, 'left')).toBe(false);
    const blocked = splitSlotWithTab(layout, slotId, chatFileTabId(c), slotId, 'right');
    expect(blocked.newSlotId).toBeNull();
    expect(blocked.layout).toBe(layout);

    // Two down splits in column 0 -> 3 rows.
    slotId = rootSlotId(layout);
    for (const t of [c, workspaceChatFileTab('d.ts')]) {
      const r = splitSlotWithTab(layout, slotId, chatFileTabId(t), slotId, 'bottom');
      layout = r.layout;
    }
    expect(layout.columns[0]!.slots).toHaveLength(EDITOR_GRID_MAX_ROWS);
    expect(canSplit(layout, slotId, 'bottom')).toBe(false);
    expect(canSplit(layout, slotId, 'top')).toBe(false);
  });

  it('collapses an emptied source slot after splitting away its only tab', () => {
    let layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    layout = splitSlotWithTab(layout, slotId, idA, slotId, 'right').layout;
    const rightId = layout.columns[1]!.slots[0]!.id;
    // Move b right too -> left column empties and collapses.
    layout = moveTabToSlot(layout, slotId, idB, rightId);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.slots[0]!.id).toBe(rightId);
    expect(layout.columns[0]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idA, idB]);
    expect(layout.columnSizes).toEqual([1]);
  });

  it('allows the same file to live in two slots and reports both', () => {
    let layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    layout = splitSlotWithTab(layout, slotId, idB, slotId, 'right').layout;
    const rightId = layout.columns[1]!.slots[0]!.id;
    layout = addTabToSlot(layout, rightId, a);
    expect(slotIdsContainingModelKey(layout, 'rel:src/a.ts').sort()).toEqual([slotId, rightId].sort());
    expect(allTabsFlat(layout).map(chatFileTabId).sort()).toEqual([idA, idB].sort());
  });

  it('removes a tab from one slot and picks the last remaining as active', () => {
    let layout = singleSlotLayout([a, b, c], idB);
    const slotId = rootSlotId(layout);
    layout = removeTabFromSlot(layout, slotId, 'rel:src/b.ts');
    expect(layout.columns[0]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idA, chatFileTabId(c)]);
    expect(layout.columns[0]!.slots[0]!.activeTabId).toBe(chatFileTabId(c));
  });

  it('never returns zero slots after removing the last tab', () => {
    let layout = singleSlotLayout([a]);
    layout = removeTabEverywhere(layout, 'rel:src/a.ts');
    expect(slotCount(layout)).toBe(1);
    expect(layout.columns[0]!.slots[0]!.tabs).toEqual([]);
    expect(layout.columns[0]!.slots[0]!.activeTabId).toBeNull();
  });

  it('reorders tabs within a slot and ignores bad indices', () => {
    let layout = singleSlotLayout([a, b, c]);
    const slotId = rootSlotId(layout);
    layout = reorderTabInSlot(layout, slotId, 0, 2);
    expect(layout.columns[0]!.slots[0]!.tabs.map(chatFileTabId)).toEqual([idB, chatFileTabId(c), idA]);
    const same = reorderTabInSlot(layout, slotId, 5, 0);
    expect(same.columns[0]!.slots[0]!.tabs).toEqual(layout.columns[0]!.slots[0]!.tabs);
  });

  it('moving onto a slot that already has the file dedupes and activates', () => {
    let layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    layout = splitSlotWithTab(layout, slotId, idB, slotId, 'right').layout;
    const rightId = layout.columns[1]!.slots[0]!.id;
    layout = addTabToSlot(layout, rightId, a);
    layout = moveTabToSlot(layout, slotId, idA, rightId);
    const right = findSlot(layout, rightId)!.slot;
    expect(right.tabs.filter((t) => chatFileTabId(t) === idA)).toHaveLength(1);
    expect(right.activeTabId).toBe(idA);
    // Source collapsed (a was its only tab).
    expect(layout.columns).toHaveLength(1);
  });

  it('setActiveTab ignores ids not in the slot', () => {
    const layout = singleSlotLayout([a, b], idA);
    const slotId = rootSlotId(layout);
    expect(setActiveTab(layout, slotId, 'file:rel:nope').columns[0]!.slots[0]!.activeTabId).toBe(idA);
    expect(setActiveTab(layout, slotId, idB).columns[0]!.slots[0]!.activeTabId).toBe(idB);
  });

  it('adjustSizesAtGutter respects min and keeps the pair sum', () => {
    const grown = adjustSizesAtGutter([0.5, 0.5], 0, 0.2);
    expect(grown[0]).toBeCloseTo(0.7);
    expect(grown[1]).toBeCloseTo(0.3);
    const clamped = adjustSizesAtGutter([0.5, 0.5], 0, 0.9);
    expect(clamped[0]).toBeCloseTo(0.9);
    expect(clamped[1]).toBeCloseTo(0.1);
    expect(adjustSizesAtGutter([1], 0, 0.2)).toEqual([1]);
  });

  it('collapseEmpty keeps an explicitly retained empty slot', () => {
    const layout = singleSlotLayout([]);
    const slotId = rootSlotId(layout);
    expect(collapseEmpty(layout, slotId).columns[0]!.slots[0]!.id).toBe(slotId);
  });

  it('resolveFocusedSlotId falls back to the first slot', () => {
    const layout = singleSlotLayout([a]);
    expect(resolveFocusedSlotId(layout, 'missing')).toBe(rootSlotId(layout));
    expect(resolveFocusedSlotId(layout, rootSlotId(layout))).toBe(rootSlotId(layout));
  });
});
