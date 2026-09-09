import { describe, expect, it } from 'vitest';

import {
  buildPlanChatFileTab,
  chatFileTabId,
  workspaceChatFileTab,
} from '../app-chat-file-tabs';
import { addTabToSlot, singleSlotLayout, splitSlotWithTab } from './editor-grid-layout';
import {
  editorGridLayoutFromPersistedState,
  serializeEditorGridOpenTabs,
} from './editor-grid-persistence';

const A = workspaceChatFileTab('a.ts');
const B = workspaceChatFileTab('b.ts');
const EXT = { absolutePath: 'C:/tmp/out.ts', outsideWorkspace: true };

describe('serializeEditorGridOpenTabs', () => {
  it('omits build-plan tabs and keeps a flat deduped tab list', () => {
    const layout = singleSlotLayout(
      [A, buildPlanChatFileTab('.clara/build-plans/p1.md', 'p1', true), EXT],
      chatFileTabId(A),
    );
    const slotId = layout.columns[0]!.slots[0]!.id;
    const state = serializeEditorGridOpenTabs(layout, slotId);
    expect(state.tabs).toEqual([
      { relativePath: 'a.ts', outsideWorkspace: false },
      { absolutePath: 'C:/tmp/out.ts', outsideWorkspace: true },
    ]);
    expect(state.activeTabId).toBe('file:rel:a.ts');
    expect(state.layout?.columns).toEqual([
      {
        slots: [{ tabIds: ['file:rel:a.ts', 'file:abs:C:/tmp/out.ts'], activeTabId: 'file:rel:a.ts' }],
        rowSizes: [1],
      },
    ]);
    expect(state.layout?.focused).toEqual([0, 0]);
  });

  it('falls back to the last file tab when the active tab is ephemeral', () => {
    const plan = buildPlanChatFileTab('.clara/build-plans/p1.md', 'p1', true);
    const layout = singleSlotLayout([A, plan], chatFileTabId(plan));
    const state = serializeEditorGridOpenTabs(layout, layout.columns[0]!.slots[0]!.id);
    expect(state.activeTabId).toBe('file:rel:a.ts');
    expect(state.layout?.columns[0]?.slots[0]?.activeTabId).toBe('file:rel:a.ts');
  });

  it('records a split layout and the same file in two slots once in the flat list', () => {
    const base = singleSlotLayout([A, B], chatFileTabId(A));
    const slotId = base.columns[0]!.slots[0]!.id;
    const { layout: splitLayout, newSlotId: rightId } = splitSlotWithTab(
      base,
      slotId,
      chatFileTabId(B),
      slotId,
      'right',
    );
    // Open A in the right slot too (same file in two slots).
    const split = addTabToSlot(splitLayout, rightId!, A);

    const state = serializeEditorGridOpenTabs(split, rightId);
    expect(state.tabs.map((t) => t.relativePath)).toEqual(['a.ts', 'b.ts']);
    expect(state.layout?.columns.map((c) => c.slots[0]!.tabIds)).toEqual([
      ['file:rel:a.ts'],
      ['file:rel:b.ts', 'file:rel:a.ts'],
    ]);
    expect(state.layout?.focused).toEqual([1, 0]);
    expect(state.activeTabId).toBe('file:rel:a.ts');
    const sum = state.layout!.columnSizes.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
  });

  it('drops slots that only held ephemeral tabs and omits the layout when nothing persists', () => {
    const plan = buildPlanChatFileTab('.clara/build-plans/p1.md', 'p1', true);
    const layout = singleSlotLayout([plan], chatFileTabId(plan));
    const state = serializeEditorGridOpenTabs(layout, layout.columns[0]!.slots[0]!.id);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.layout).toBeUndefined();
  });
});

describe('editorGridLayoutFromPersistedState', () => {
  it('returns one empty slot for missing state', () => {
    const { layout, focusedSlotId } = editorGridLayoutFromPersistedState(null);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.slots).toHaveLength(1);
    expect(layout.columns[0]!.slots[0]!.tabs).toEqual([]);
    expect(focusedSlotId).toBe(layout.columns[0]!.slots[0]!.id);
  });

  it('restores legacy single-strip state into a single slot', () => {
    const { layout, focusedSlotId } = editorGridLayoutFromPersistedState({
      tabs: [
        { relativePath: 'src/foo.ts', outsideWorkspace: false },
        { absolutePath: 'C:/tmp/out.ts', outsideWorkspace: true },
      ],
      activeTabId: 'file:abs:C:/tmp/out.ts',
    });
    const slot = layout.columns[0]!.slots[0]!;
    expect(layout.columns).toHaveLength(1);
    expect(slot.tabs).toHaveLength(2);
    expect(slot.tabs[0]?.relativePath).toBe('src/foo.ts');
    expect(slot.tabs[1]?.outsideWorkspace).toBe(true);
    expect(slot.activeTabId).toBe('file:abs:C:/tmp/out.ts');
    expect(focusedSlotId).toBe(slot.id);
  });

  it('round-trips a split layout with focus', () => {
    const base = singleSlotLayout([A, B], chatFileTabId(A));
    const slotId = base.columns[0]!.slots[0]!.id;
    const { layout: split, newSlotId: bottomId } = splitSlotWithTab(
      base,
      slotId,
      chatFileTabId(B),
      slotId,
      'bottom',
    );
    const state = serializeEditorGridOpenTabs(split, bottomId);

    const { layout, focusedSlotId } = editorGridLayoutFromPersistedState(state);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.slots).toHaveLength(2);
    expect(layout.columns[0]!.slots[0]!.tabs.map((t) => t.relativePath)).toEqual(['a.ts']);
    expect(layout.columns[0]!.slots[1]!.tabs.map((t) => t.relativePath)).toEqual(['b.ts']);
    expect(focusedSlotId).toBe(layout.columns[0]!.slots[1]!.id);
  });

  it('puts tabs not referenced by any slot into the first slot', () => {
    const { layout } = editorGridLayoutFromPersistedState({
      tabs: [
        { relativePath: 'a.ts', outsideWorkspace: false },
        { relativePath: 'b.ts', outsideWorkspace: false },
      ],
      activeTabId: 'file:rel:a.ts',
      layout: {
        columns: [{ slots: [{ tabIds: ['file:rel:a.ts'], activeTabId: 'file:rel:a.ts' }], rowSizes: [1] }],
        columnSizes: [1],
      },
    });
    expect(layout.columns[0]!.slots[0]!.tabs.map((t) => t.relativePath)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to a single slot when every persisted slot references unknown tabs', () => {
    const { layout } = editorGridLayoutFromPersistedState({
      tabs: [{ relativePath: 'a.ts', outsideWorkspace: false }],
      activeTabId: 'file:rel:a.ts',
      layout: {
        columns: [{ slots: [{ tabIds: ['file:rel:missing.ts'], activeTabId: null }], rowSizes: [1] }],
        columnSizes: [1],
      },
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.slots[0]!.tabs.map((t) => t.relativePath)).toEqual(['a.ts']);
  });
});
