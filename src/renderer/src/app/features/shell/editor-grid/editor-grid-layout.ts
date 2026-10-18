import { type ChatFileTab, chatFileTabId, chatFileTabModelKey } from '../app-chat-file-tabs';

export const EDITOR_GRID_MAX_COLUMNS = 3;
export const EDITOR_GRID_MAX_ROWS = 3;

/** One tab group: many tabs, one active. Rendered with its own strip + editor. */
export interface EditorGridSlot {
  id: string;
  tabs: ChatFileTab[];
  activeTabId: string | null;
}

/** Vertical stack of slots. */
export interface EditorGridColumn {
  id: string;
  slots: EditorGridSlot[];
  /** Fractions summing to 1, one per slot. */
  rowSizes: number[];
}

/** Horizontal list of columns (max 3), each with up to 3 slots. */
export interface EditorGridLayout {
  columns: EditorGridColumn[];
  /** Fractions summing to 1, one per column. */
  columnSizes: number[];
}

export type EditorGridSplitSide = 'left' | 'right' | 'top' | 'bottom';

export interface EditorGridSlotLocation {
  columnIndex: number;
  rowIndex: number;
  column: EditorGridColumn;
  slot: EditorGridSlot;
}

let idSeq = 0;

/** Test hook: deterministic ids. */
export function resetEditorGridIdSeq(): void {
  idSeq = 0;
}

export function newEditorGridId(prefix: 'slot' | 'col'): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

export function evenSizes(count: number): number[] {
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, () => 1 / count);
}

/** Clamp + renormalise so sizes are positive and sum to 1. */
export function normalizeSizes(sizes: readonly number[], count: number, min = 0.1): number[] {
  if (count <= 0) {
    return [];
  }
  if (sizes.length !== count || sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
    return evenSizes(count);
  }
  const clamped = sizes.map((s) => Math.max(min, s));
  const total = clamped.reduce((a, b) => a + b, 0);
  return clamped.map((s) => s / total);
}

export function createSlot(tabs: readonly ChatFileTab[] = [], activeTabId: string | null = null): EditorGridSlot {
  const list = [...tabs];
  const active =
    activeTabId && list.some((t) => chatFileTabId(t) === activeTabId)
      ? activeTabId
      : list.length > 0
        ? chatFileTabId(list[list.length - 1]!)
        : null;
  return { id: newEditorGridId('slot'), tabs: list, activeTabId: active };
}

export function singleSlotLayout(tabs: readonly ChatFileTab[] = [], activeTabId: string | null = null): EditorGridLayout {
  const slot = createSlot(tabs, activeTabId);
  return {
    columns: [{ id: newEditorGridId('col'), slots: [slot], rowSizes: [1] }],
    columnSizes: [1],
  };
}

export function allSlots(layout: EditorGridLayout): EditorGridSlot[] {
  return layout.columns.flatMap((c) => c.slots);
}

export function firstSlotId(layout: EditorGridLayout): string | null {
  return layout.columns[0]?.slots[0]?.id ?? null;
}

export function findSlot(layout: EditorGridLayout, slotId: string): EditorGridSlotLocation | null {
  for (let ci = 0; ci < layout.columns.length; ci++) {
    const column = layout.columns[ci]!;
    for (let ri = 0; ri < column.slots.length; ri++) {
      const slot = column.slots[ri]!;
      if (slot.id === slotId) {
        return { columnIndex: ci, rowIndex: ri, column, slot };
      }
    }
  }
  return null;
}

export function slotById(layout: EditorGridLayout, slotId: string | null): EditorGridSlot | null {
  return slotId ? (findSlot(layout, slotId)?.slot ?? null) : null;
}

/** Every open tab across all slots, de-duplicated by model key (first occurrence wins). */
export function allTabsFlat(layout: EditorGridLayout): ChatFileTab[] {
  const seen = new Set<string>();
  const out: ChatFileTab[] = [];
  for (const slot of allSlots(layout)) {
    for (const tab of slot.tabs) {
      const key = chatFileTabModelKey(tab);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(tab);
    }
  }
  return out;
}

export function slotIdsContainingModelKey(layout: EditorGridLayout, modelKey: string): string[] {
  return allSlots(layout)
    .filter((s) => s.tabs.some((t) => chatFileTabModelKey(t) === modelKey))
    .map((s) => s.id);
}

export function slotIdsContainingTabId(layout: EditorGridLayout, tabId: string): string[] {
  return allSlots(layout)
    .filter((s) => s.tabs.some((t) => chatFileTabId(t) === tabId))
    .map((s) => s.id);
}

export function canSplit(layout: EditorGridLayout, slotId: string, side: EditorGridSplitSide): boolean {
  const loc = findSlot(layout, slotId);
  if (!loc) {
    return false;
  }
  if (side === 'left' || side === 'right') {
    return layout.columns.length < EDITOR_GRID_MAX_COLUMNS;
  }
  return loc.column.slots.length < EDITOR_GRID_MAX_ROWS;
}

function replaceSlot(layout: EditorGridLayout, slotId: string, fn: (slot: EditorGridSlot) => EditorGridSlot): EditorGridLayout {
  return {
    ...layout,
    columns: layout.columns.map((c) => ({
      ...c,
      slots: c.slots.map((s) => (s.id === slotId ? fn(s) : s)),
    })),
  };
}

/** Remove empty slots and empty columns, redistributing sizes. Never returns zero slots. */
export function collapseEmpty(layout: EditorGridLayout, keepSlotId?: string | null): EditorGridLayout {
  const columns: EditorGridColumn[] = [];
  const columnSizes: number[] = [];
  layout.columns.forEach((column, ci) => {
    const slots: EditorGridSlot[] = [];
    const rowSizes: number[] = [];
    column.slots.forEach((slot, ri) => {
      if (slot.tabs.length > 0 || slot.id === keepSlotId) {
        slots.push(slot);
        rowSizes.push(column.rowSizes[ri] ?? 1 / column.slots.length);
      }
    });
    if (slots.length > 0) {
      columns.push({ ...column, slots, rowSizes: normalizeSizes(rowSizes, slots.length) });
      columnSizes.push(layout.columnSizes[ci] ?? 1 / layout.columns.length);
    }
  });
  if (columns.length === 0) {
    const first = layout.columns[0]?.slots[0];
    const slot = first ? { ...first, tabs: [], activeTabId: null } : createSlot();
    return {
      columns: [{ id: layout.columns[0]?.id ?? newEditorGridId('col'), slots: [slot], rowSizes: [1] }],
      columnSizes: [1],
    };
  }
  return { columns, columnSizes: normalizeSizes(columnSizes, columns.length) };
}

export function setActiveTab(layout: EditorGridLayout, slotId: string, tabId: string | null): EditorGridLayout {
  return replaceSlot(layout, slotId, (slot) => {
    if (tabId && !slot.tabs.some((t) => chatFileTabId(t) === tabId)) {
      return slot;
    }
    return { ...slot, activeTabId: tabId };
  });
}

/** Add a tab to a slot (no duplicate within the same slot) and make it active. */
export function addTabToSlot(
  layout: EditorGridLayout,
  slotId: string,
  tab: ChatFileTab,
  index?: number,
): EditorGridLayout {
  const key = chatFileTabModelKey(tab);
  return replaceSlot(layout, slotId, (slot) => {
    const existing = slot.tabs.find((t) => chatFileTabModelKey(t) === key);
    if (existing) {
      return { ...slot, activeTabId: chatFileTabId(existing) };
    }
    const tabs = [...slot.tabs];
    const at = index == null ? tabs.length : Math.max(0, Math.min(tabs.length, index));
    tabs.splice(at, 0, tab);
    return { ...slot, tabs, activeTabId: chatFileTabId(tab) };
  });
}

/**
 * Replace tab objects wherever they appear (build-plan flags, rename, Save As). When `remap`
 * is given, slots whose active tab was `remap.oldTabId` follow it to `remap.newTabId`.
 */
export function updateTabsEverywhere(
  layout: EditorGridLayout,
  fn: (tabs: readonly ChatFileTab[]) => ChatFileTab[],
  remap?: { oldTabId: string; newTabId: string },
): EditorGridLayout {
  return {
    ...layout,
    columns: layout.columns.map((c) => ({
      ...c,
      slots: c.slots.map((s) => {
        const tabs = fn(s.tabs);
        if (tabs === s.tabs) {
          return s;
        }
        let wanted = s.activeTabId;
        if (remap && wanted === remap.oldTabId) {
          wanted = remap.newTabId;
        }
        const active =
          wanted && tabs.some((t) => chatFileTabId(t) === wanted)
            ? wanted
            : tabs.length > 0
              ? chatFileTabId(tabs[tabs.length - 1]!)
              : null;
        return { ...s, tabs, activeTabId: active };
      }),
    })),
  };
}

function nextActiveAfterRemoval(slot: EditorGridSlot, removedTabId: string, remaining: ChatFileTab[]): string | null {
  if (slot.activeTabId !== removedTabId) {
    return slot.activeTabId;
  }
  return remaining.length > 0 ? chatFileTabId(remaining[remaining.length - 1]!) : null;
}

/** Remove a tab (by model key) from one slot; collapses the slot / column if emptied. */
export function removeTabFromSlot(
  layout: EditorGridLayout,
  slotId: string,
  modelKey: string,
  opts: { collapse?: boolean } = {},
): EditorGridLayout {
  const next = replaceSlot(layout, slotId, (slot) => {
    const removed = slot.tabs.find((t) => chatFileTabModelKey(t) === modelKey);
    if (!removed) {
      return slot;
    }
    const remaining = slot.tabs.filter((t) => chatFileTabModelKey(t) !== modelKey);
    return { ...slot, tabs: remaining, activeTabId: nextActiveAfterRemoval(slot, chatFileTabId(removed), remaining) };
  });
  return opts.collapse === false ? next : collapseEmpty(next);
}

/** Remove a tab (by model key) from every slot. */
export function removeTabEverywhere(layout: EditorGridLayout, modelKey: string): EditorGridLayout {
  let next = layout;
  for (const slot of allSlots(layout)) {
    next = removeTabFromSlot(next, slot.id, modelKey, { collapse: false });
  }
  return collapseEmpty(next);
}

export function reorderTabInSlot(layout: EditorGridLayout, slotId: string, fromIndex: number, toIndex: number): EditorGridLayout {
  return replaceSlot(layout, slotId, (slot) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= slot.tabs.length ||
      toIndex >= slot.tabs.length
    ) {
      return slot;
    }
    const tabs = [...slot.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    if (!moved) {
      return slot;
    }
    tabs.splice(toIndex, 0, moved);
    return { ...slot, tabs };
  });
}

/**
 * Move a tab from one slot into another (at `index`, default: end). If the target already
 * has that file, the source copy is removed and the target's copy becomes active.
 */
export function moveTabToSlot(
  layout: EditorGridLayout,
  fromSlotId: string,
  tabId: string,
  toSlotId: string,
  index?: number,
): EditorGridLayout {
  const from = slotById(layout, fromSlotId);
  const tab = from?.tabs.find((t) => chatFileTabId(t) === tabId);
  if (!from || !tab) {
    return layout;
  }
  if (fromSlotId === toSlotId) {
    const fromIndex = from.tabs.indexOf(tab);
    return index == null ? layout : reorderTabInSlot(layout, fromSlotId, fromIndex, index);
  }
  const key = chatFileTabModelKey(tab);
  let next = removeTabFromSlot(layout, fromSlotId, key, { collapse: false });
  next = addTabToSlot(next, toSlotId, tab, index);
  return collapseEmpty(next, toSlotId);
}

/**
 * Split `targetSlotId` on `side`, creating a new slot that receives `tabId` from `fromSlotId`.
 * Left/right insert a full-height column; top/bottom insert a row in the target's column.
 * Returns the unchanged layout when the 3x3 limit is reached.
 */
export function splitSlotWithTab(
  layout: EditorGridLayout,
  fromSlotId: string,
  tabId: string,
  targetSlotId: string,
  side: EditorGridSplitSide,
): { layout: EditorGridLayout; newSlotId: string | null } {
  const from = slotById(layout, fromSlotId);
  const tab = from?.tabs.find((t) => chatFileTabId(t) === tabId);
  if (!from || !tab || !canSplit(layout, targetSlotId, side)) {
    return { layout, newSlotId: null };
  }
  const newSlot = createSlot([tab], tabId);
  const next = removeTabFromSlot(layout, fromSlotId, chatFileTabModelKey(tab), { collapse: false });
  return insertSplitSlot(layout, next, targetSlotId, side, newSlot);
}

/**
 * Split `targetSlotId` on `side`, creating a new slot holding `tab` (a tab that is not being
 * moved from another slot, e.g. a file dropped from the workspace tree). Returns the unchanged
 * layout when the 3x3 limit is reached.
 */
export function splitSlotWithNewTab(
  layout: EditorGridLayout,
  targetSlotId: string,
  side: EditorGridSplitSide,
  tab: ChatFileTab,
): { layout: EditorGridLayout; newSlotId: string | null } {
  if (!canSplit(layout, targetSlotId, side)) {
    return { layout, newSlotId: null };
  }
  const newSlot = createSlot([tab], chatFileTabId(tab));
  return insertSplitSlot(layout, layout, targetSlotId, side, newSlot);
}

/**
 * Insert `newSlot` beside `targetSlotId` in `next`, giving it half of the target's size.
 * `original` is returned untouched when the target cannot be found.
 */
function insertSplitSlot(
  original: EditorGridLayout,
  next: EditorGridLayout,
  targetSlotId: string,
  side: EditorGridSplitSide,
  newSlot: EditorGridSlot,
): { layout: EditorGridLayout; newSlotId: string | null } {
  const loc = findSlot(next, targetSlotId);
  if (!loc) {
    return { layout: original, newSlotId: null };
  }
  if (side === 'left' || side === 'right') {
    const insertAt = side === 'left' ? loc.columnIndex : loc.columnIndex + 1;
    const columns = [...next.columns];
    columns.splice(insertAt, 0, { id: newEditorGridId('col'), slots: [newSlot], rowSizes: [1] });
    // Give the new column half of the target column's width.
    const sizes = [...next.columnSizes];
    const targetSize = sizes[loc.columnIndex] ?? 1 / next.columns.length;
    sizes[loc.columnIndex] = targetSize / 2;
    sizes.splice(insertAt, 0, targetSize / 2);
    next = { columns, columnSizes: normalizeSizes(sizes, columns.length) };
  } else {
    const insertAt = side === 'top' ? loc.rowIndex : loc.rowIndex + 1;
    const slots = [...loc.column.slots];
    slots.splice(insertAt, 0, newSlot);
    const sizes = [...loc.column.rowSizes];
    const targetSize = sizes[loc.rowIndex] ?? 1 / loc.column.slots.length;
    sizes[loc.rowIndex] = targetSize / 2;
    sizes.splice(insertAt, 0, targetSize / 2);
    const column: EditorGridColumn = { ...loc.column, slots, rowSizes: normalizeSizes(sizes, slots.length) };
    const columns = next.columns.map((c, i) => (i === loc.columnIndex ? column : c));
    next = { ...next, columns };
  }
  return { layout: collapseEmpty(next, newSlot.id), newSlotId: newSlot.id };
}

export function resizeColumns(layout: EditorGridLayout, sizes: readonly number[]): EditorGridLayout {
  return { ...layout, columnSizes: normalizeSizes(sizes, layout.columns.length) };
}

export function resizeRows(layout: EditorGridLayout, columnId: string, sizes: readonly number[]): EditorGridLayout {
  return {
    ...layout,
    columns: layout.columns.map((c) =>
      c.id === columnId ? { ...c, rowSizes: normalizeSizes(sizes, c.slots.length) } : c,
    ),
  };
}

/**
 * Drag a gutter between `index` and `index + 1` by `deltaFraction` of the total size.
 * Both neighbours are clamped to `min`.
 */
export function adjustSizesAtGutter(
  sizes: readonly number[],
  index: number,
  deltaFraction: number,
  min = 0.1,
): number[] {
  if (index < 0 || index >= sizes.length - 1) {
    return [...sizes];
  }
  const a = sizes[index]!;
  const b = sizes[index + 1]!;
  const pair = a + b;
  let nextA = a + deltaFraction;
  nextA = Math.max(min, Math.min(pair - min, nextA));
  const next = [...sizes];
  next[index] = nextA;
  next[index + 1] = pair - nextA;
  return next;
}

/** Count of slots in the grid. */
export function slotCount(layout: EditorGridLayout): number {
  return allSlots(layout).length;
}

/** Pick a fallback focus slot when `slotId` no longer exists. */
export function resolveFocusedSlotId(layout: EditorGridLayout, slotId: string | null): string | null {
  if (slotId && findSlot(layout, slotId)) {
    return slotId;
  }
  return firstSlotId(layout);
}
