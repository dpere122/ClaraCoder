import type {
  WorkspaceOpenTabsState,
  WorkspacePersistedEditorGridLayout,
  WorkspacePersistedOpenTab,
} from '@shared/index';
import {
  type ChatFileTab,
  chatFileTabFromPersisted,
  chatFileTabId,
  toPersistedOpenTab,
} from '../app-chat-file-tabs';
import {
  createSlot,
  type EditorGridColumn,
  type EditorGridLayout,
  type EditorGridSlot,
  findSlot,
  newEditorGridId,
  normalizeSizes,
  singleSlotLayout,
} from './editor-grid-layout';

/**
 * Persist the grid: `tabs` is the flat de-duplicated union (backward compatible with the
 * single-strip format), `layout` records slots by tab id. Ephemeral tabs are omitted; a slot
 * left empty after omission is dropped, and a layout with no slots collapses to no `layout`.
 */
export function serializeEditorGridOpenTabs(
  layout: EditorGridLayout,
  focusedSlotId: string | null,
): WorkspaceOpenTabsState {
  const persisted: WorkspacePersistedOpenTab[] = [];
  const seen = new Set<string>();
  const columns: WorkspacePersistedEditorGridLayout['columns'] = [];
  const columnSizes: number[] = [];
  let focused: [number, number] | undefined;
  let activeTabId: string | null = null;

  layout.columns.forEach((column, ci) => {
    const slots: WorkspacePersistedEditorGridLayout['columns'][number]['slots'] = [];
    const rowSizes: number[] = [];
    column.slots.forEach((slot, ri) => {
      const tabIds: string[] = [];
      for (const tab of slot.tabs) {
        const slim = toPersistedOpenTab(tab);
        if (!slim) {
          continue;
        }
        const id = chatFileTabId(slim);
        if (!id || id === 'file:' || tabIds.includes(id)) {
          continue;
        }
        tabIds.push(id);
        if (!seen.has(id)) {
          seen.add(id);
          persisted.push(slim);
        }
      }
      if (tabIds.length === 0) {
        return;
      }
      const active = slot.activeTabId && tabIds.includes(slot.activeTabId) ? slot.activeTabId : tabIds[tabIds.length - 1]!;
      if (slot.id === focusedSlotId) {
        focused = [columns.length, slots.length];
        activeTabId = active;
      }
      slots.push({ tabIds, activeTabId: active });
      rowSizes.push(column.rowSizes[ri] ?? 1 / column.slots.length);
    });
    if (slots.length > 0) {
      columns.push({ slots, rowSizes: normalizeSizes(rowSizes, slots.length) });
      columnSizes.push(layout.columnSizes[ci] ?? 1 / layout.columns.length);
    }
  });

  if (!activeTabId) {
    const firstSlot = columns[0]?.slots[0];
    activeTabId = firstSlot?.activeTabId ?? (persisted.length > 0 ? chatFileTabId(persisted[persisted.length - 1]!) : null);
  }
  if (columns.length === 0) {
    return { tabs: persisted, activeTabId };
  }
  const out: WorkspacePersistedEditorGridLayout = {
    columns,
    columnSizes: normalizeSizes(columnSizes, columns.length),
  };
  if (focused) {
    out.focused = focused;
  }
  return { tabs: persisted, activeTabId, layout: out };
}

/** Rebuild the grid from persisted state; falls back to a single slot when `layout` is absent. */
export function editorGridLayoutFromPersistedState(
  state: WorkspaceOpenTabsState | null | undefined,
): { layout: EditorGridLayout; focusedSlotId: string | null } {
  if (!state) {
    const layout = singleSlotLayout([], null);
    return { layout, focusedSlotId: layout.columns[0]!.slots[0]!.id };
  }
  const tabById = new Map<string, ChatFileTab>();
  const ordered: ChatFileTab[] = [];
  for (const raw of state.tabs) {
    const tab = chatFileTabFromPersisted(raw);
    if (!tab) {
      continue;
    }
    const id = chatFileTabId(tab);
    if (!id || id === 'file:' || tabById.has(id)) {
      continue;
    }
    tabById.set(id, tab);
    ordered.push(tab);
  }
  const active = state.activeTabId?.trim() || null;

  if (!state.layout) {
    const layout = singleSlotLayout(ordered, active && tabById.has(active) ? active : null);
    return { layout, focusedSlotId: layout.columns[0]!.slots[0]!.id };
  }

  const columns: EditorGridColumn[] = [];
  const columnSizes: number[] = [];
  const focusRef: { id: string | null } = { id: null };
  const persistedFocus = state.layout.focused;
  state.layout.columns.forEach((column, ci) => {
    const slots: EditorGridSlot[] = [];
    const rowSizes: number[] = [];
    column.slots.forEach((slotRaw, ri) => {
      const tabs = slotRaw.tabIds.map((id) => tabById.get(id)).filter((t): t is ChatFileTab => !!t);
      if (tabs.length === 0) {
        return;
      }
      const slot = createSlot(tabs, slotRaw.activeTabId);
      if (persistedFocus && persistedFocus[0] === ci && persistedFocus[1] === ri) {
        focusRef.id = slot.id;
      }
      slots.push(slot);
      rowSizes.push(column.rowSizes[ri] ?? 1 / column.slots.length);
    });
    if (slots.length > 0) {
      columns.push({ id: newEditorGridId('col'), slots, rowSizes: normalizeSizes(rowSizes, slots.length) });
      columnSizes.push(state.layout!.columnSizes[ci] ?? 1 / state.layout!.columns.length);
    }
  });

  if (columns.length === 0) {
    const layout = singleSlotLayout(ordered, active && tabById.has(active) ? active : null);
    return { layout, focusedSlotId: layout.columns[0]!.slots[0]!.id };
  }
  // Any tab in the flat list that no slot references lands in the first slot (defensive).
  const referenced = new Set(columns.flatMap((c) => c.slots.flatMap((s) => s.tabs.map(chatFileTabId))));
  const orphans = ordered.filter((t) => !referenced.has(chatFileTabId(t)));
  if (orphans.length > 0) {
    const first = columns[0]!.slots[0]!;
    first.tabs = [...first.tabs, ...orphans];
  }
  const layout: EditorGridLayout = { columns, columnSizes: normalizeSizes(columnSizes, columns.length) };
  const focusedSlotId =
    focusRef.id && findSlot(layout, focusRef.id) ? focusRef.id : layout.columns[0]!.slots[0]!.id;
  return { layout, focusedSlotId };
}
