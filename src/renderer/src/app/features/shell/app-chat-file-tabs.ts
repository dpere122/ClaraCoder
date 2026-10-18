import { normalizePathSlashes } from '../../utils/workspace-relative-path';
import type { WorkspacePersistedOpenTab } from '@shared/index';
import {
  editorModelKeyForAbsolutePath,
  editorModelKeyForRelativePath,
  type OpenEditorFileRef,
  openEditorFileRefFromRelativePath,
  turnDiffModelKey,
} from '../workspace/open-editor-file-ref';

/** Read-only before/after diff of one file a past user turn edited. */
export interface ChatFileTabTurnDiff {
  userMessageId: string;
  /** Workspace-relative path the turn edited. */
  relativePath: string;
  turnNumber: number;
}

export interface ChatFileTab {
  /** Workspace-relative path when the file lives in the open workspace. */
  relativePath?: string;
  /** Absolute on-disk path when the tab is external (outside workspace). */
  absolutePath?: string;
  /** True when editing a file outside the workspace root. */
  outsideWorkspace?: boolean;
  /** Build plan id when this tab shows a `.clara/build-plans/` markdown file. */
  buildPlanId?: string;
  /** True while the plan awaits confirm or is executing; closing tab cancels the plan. */
  buildPlanActive?: boolean;
  /** Preview-only markdown tab (no edit/preview toggle). */
  previewOnly?: boolean;
  /** Set on read-only turn-diff tabs (id `turn-diff:<msgId>:<path>`); no workspace model. */
  turnDiff?: ChatFileTabTurnDiff;
}

export function turnDiffChatFileTab(turnDiff: ChatFileTabTurnDiff): ChatFileTab {
  return { turnDiff: { ...turnDiff, relativePath: normalizePathSlashes(turnDiff.relativePath) } };
}

export function chatFileTabModelKey(tab: ChatFileTab): string {
  if (tab.turnDiff) {
    return turnDiffModelKey(tab.turnDiff.userMessageId, tab.turnDiff.relativePath);
  }
  if (tab.outsideWorkspace && tab.absolutePath?.trim()) {
    return editorModelKeyForAbsolutePath(tab.absolutePath.trim());
  }
  const rel = tab.relativePath?.trim();
  if (!rel) {
    return '';
  }
  return editorModelKeyForRelativePath(rel);
}

export function chatFileTabId(tab: ChatFileTab): string {
  if (tab.turnDiff) {
    return chatFileTabModelKey(tab);
  }
  const key = chatFileTabModelKey(tab);
  return key ? `file:${key}` : 'file:';
}

export function chatFileTabBasename(tab: ChatFileTab): string {
  if (tab.turnDiff) {
    const n = normalizePathSlashes(tab.turnDiff.relativePath);
    const i = n.lastIndexOf('/');
    return `${i >= 0 ? n.slice(i + 1) : n} (turn ${tab.turnDiff.turnNumber})`;
  }
  if (tab.absolutePath?.trim()) {
    const n = normalizePathSlashes(tab.absolutePath.trim());
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
  }
  const rel = tab.relativePath?.trim() ?? '';
  const n = normalizePathSlashes(rel);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

export function openEditorFileRefFromTab(tab: ChatFileTab): OpenEditorFileRef | null {
  if (tab.turnDiff) {
    return null;
  }
  const modelKey = chatFileTabModelKey(tab);
  if (!modelKey) {
    return null;
  }
  return {
    modelKey,
    relativePath: tab.relativePath?.trim() ? normalizePathSlashes(tab.relativePath.trim()) : undefined,
    absolutePath: tab.absolutePath?.trim() ? tab.absolutePath.trim() : undefined,
    outsideWorkspace: !!tab.outsideWorkspace,
  };
}

export function retargetFileTabPath(
  tabs: readonly ChatFileTab[],
  oldRelativePath: string,
  newRelativePath: string,
): ChatFileTab[] {
  const oldNorm = normalizePathSlashes(oldRelativePath);
  const newNorm = normalizePathSlashes(newRelativePath);
  return tabs.map((t) => {
    if (t.outsideWorkspace || !t.relativePath) {
      return t;
    }
    if (normalizePathSlashes(t.relativePath) !== oldNorm) {
      return t;
    }
    return { relativePath: newNorm, outsideWorkspace: false };
  });
}

/** Keep the old-path tab (Monaco marks it detached) and open a tab for the renamed file. */
export function openTabForRenamedFile(
  tabs: readonly ChatFileTab[],
  oldRelativePath: string,
  newRelativePath: string,
): { tabs: ChatFileTab[]; focusTabId: string | null } {
  const oldNorm = normalizePathSlashes(oldRelativePath);
  const newNorm = normalizePathSlashes(newRelativePath);
  if (!oldNorm || !newNorm || oldNorm === newNorm) {
    return { tabs: [...tabs], focusTabId: null };
  }

  const hadOldOpen = tabs.some(
    (t) =>
      !t.outsideWorkspace &&
      !!t.relativePath?.trim() &&
      normalizePathSlashes(t.relativePath) === oldNorm,
  );
  if (!hadOldOpen) {
    return { tabs: [...tabs], focusTabId: null };
  }

  const newTab = workspaceChatFileTab(newNorm);
  const focusTabId = chatFileTabId(newTab);
  const alreadyOpen = tabs.some((t) => chatFileTabModelKey(t) === chatFileTabModelKey(newTab));
  return {
    tabs: alreadyOpen ? [...tabs] : [...tabs, newTab],
    focusTabId,
  };
}

export function replaceFileTabAfterSaveAs(
  tabs: readonly ChatFileTab[],
  oldModelKey: string,
  result: { relativePath?: string; absolutePath?: string; outsideWorkspace: boolean },
): ChatFileTab[] {
  return tabs.map((t) => {
    if (chatFileTabModelKey(t) !== oldModelKey) {
      return t;
    }
    if (result.outsideWorkspace && result.absolutePath) {
      return {
        absolutePath: result.absolutePath,
        outsideWorkspace: true,
      };
    }
    if (result.relativePath) {
      return {
        relativePath: normalizePathSlashes(result.relativePath),
        outsideWorkspace: false,
      };
    }
    return t;
  });
}

export function findTabByModelKey(tabs: readonly ChatFileTab[], modelKey: string): ChatFileTab | undefined {
  return tabs.find((t) => chatFileTabModelKey(t) === modelKey);
}

export function chatFileTabFromModelKey(modelKey: string): ChatFileTab | null {
  if (modelKey.startsWith('rel:')) {
    return { relativePath: modelKey.slice(4), outsideWorkspace: false };
  }
  if (modelKey.startsWith('abs:')) {
    return { absolutePath: modelKey.slice(4), outsideWorkspace: true };
  }
  return null;
}

/** Legacy helper: open tab by workspace-relative path only. */
export function workspaceChatFileTab(relativePath: string): ChatFileTab {
  return { relativePath: normalizePathSlashes(relativePath), outsideWorkspace: false };
}

export function buildPlanChatFileTab(
  relativePath: string,
  planId: string,
  active = true,
): ChatFileTab {
  return {
    relativePath: normalizePathSlashes(relativePath),
    outsideWorkspace: false,
    buildPlanId: planId,
    buildPlanActive: active,
    previewOnly: true,
  };
}

export function findBuildPlanTab(tabs: readonly ChatFileTab[], planId: string): ChatFileTab | undefined {
  return tabs.find((t) => t.buildPlanId === planId);
}

export function deactivateBuildPlanTab(tabs: readonly ChatFileTab[], planId: string): ChatFileTab[] {
  return tabs.map((t) => (t.buildPlanId === planId ? { ...t, buildPlanActive: false } : t));
}

export function removeBuildPlanTab(tabs: readonly ChatFileTab[], planId: string): ChatFileTab[] {
  return tabs.filter((t) => t.buildPlanId !== planId);
}

function anchorTabIndex(tabs: readonly ChatFileTab[], anchorTabId: string): number {
  return tabs.findIndex((t) => chatFileTabId(t) === anchorTabId);
}

/** Tab ids for open files strictly to the left of `anchorTabId`. */
export function fileTabIdsToLeft(tabs: readonly ChatFileTab[], anchorTabId: string): string[] {
  const anchorIdx = anchorTabIndex(tabs, anchorTabId);
  if (anchorIdx <= 0) {
    return [];
  }
  return tabs.slice(0, anchorIdx).map((t) => chatFileTabId(t));
}

/** Tab ids for open files strictly to the right of `anchorTabId`. */
export function fileTabIdsToRight(tabs: readonly ChatFileTab[], anchorTabId: string): string[] {
  const anchorIdx = anchorTabIndex(tabs, anchorTabId);
  if (anchorIdx < 0 || anchorIdx >= tabs.length - 1) {
    return [];
  }
  return tabs.slice(anchorIdx + 1).map((t) => chatFileTabId(t));
}

/** All open file tab ids, left-to-right. */
export function allFileTabIds(tabs: readonly ChatFileTab[]): string[] {
  return tabs.map((t) => chatFileTabId(t));
}

/** Reorder open file tabs; no-op when indices are equal or out of range. */
export function reorderFileTabs(
  tabs: readonly ChatFileTab[],
  fromIndex: number,
  toIndex: number,
): ChatFileTab[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabs.length ||
    toIndex >= tabs.length
  ) {
    return [...tabs];
  }
  const next = [...tabs];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return [...tabs];
  }
  next.splice(toIndex, 0, moved);
  return next;
}

export { openEditorFileRefFromRelativePath };

/** Drop ephemeral build-plan and turn-diff tabs; keep workspace and external file tabs. */
export function toPersistedOpenTab(tab: ChatFileTab): WorkspacePersistedOpenTab | null {
  if (tab.buildPlanId || tab.previewOnly || tab.turnDiff) {
    return null;
  }
  if (tab.outsideWorkspace && tab.absolutePath?.trim()) {
    return {
      absolutePath: normalizePathSlashes(tab.absolutePath.trim()),
      outsideWorkspace: true,
    };
  }
  const rel = tab.relativePath?.trim();
  if (!rel) {
    return null;
  }
  return { relativePath: normalizePathSlashes(rel), outsideWorkspace: false };
}

export function chatFileTabFromPersisted(tab: WorkspacePersistedOpenTab): ChatFileTab | null {
  if (tab.outsideWorkspace && tab.absolutePath?.trim()) {
    return {
      absolutePath: normalizePathSlashes(tab.absolutePath.trim()),
      outsideWorkspace: true,
    };
  }
  const rel = tab.relativePath?.trim();
  if (!rel) {
    return null;
  }
  return { relativePath: normalizePathSlashes(rel), outsideWorkspace: false };
}

// Grid-aware open-tab (de)serialization lives in `editor-grid/editor-grid-persistence.ts`.

const WHEEL_LINE_PX = 16;

/** Map mouse-wheel / trackpad input onto a horizontally overflowing file-tab strip. */
export function applyFileTabStripWheelScroll(el: HTMLElement, event: WheelEvent): boolean {
  if (el.scrollWidth <= el.clientWidth) {
    return false;
  }
  const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (raw === 0) {
    return false;
  }
  const delta = event.deltaMode === 1 ? raw * WHEEL_LINE_PX : event.deltaMode === 2 ? raw * el.clientWidth : raw;
  const max = el.scrollWidth - el.clientWidth;
  const next = Math.min(max, Math.max(0, el.scrollLeft + delta));
  if (next === el.scrollLeft) {
    return false;
  }
  event.preventDefault();
  el.scrollLeft = next;
  return true;
}

export interface FileTabStripOverlayMetrics {
  overflowing: boolean;
  thumbOffsetPx: number;
  thumbSizePx: number;
}

const FILE_TAB_STRIP_MIN_THUMB_PX = 24;

/** Overlay thumb size/offset for a hidden native scrollbar. */
export function fileTabStripOverlayMetrics(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  trackWidth: number,
): FileTabStripOverlayMetrics {
  const overflow = scrollWidth - clientWidth;
  if (overflow <= 0 || clientWidth <= 0 || trackWidth <= 0 || scrollWidth <= 0) {
    return { overflowing: false, thumbOffsetPx: 0, thumbSizePx: 0 };
  }
  const thumbSizePx = Math.min(
    trackWidth,
    Math.max(FILE_TAB_STRIP_MIN_THUMB_PX, (clientWidth / scrollWidth) * trackWidth),
  );
  const maxOffset = Math.max(0, trackWidth - thumbSizePx);
  const ratio = Math.min(1, Math.max(0, scrollLeft / overflow));
  return {
    overflowing: true,
    thumbOffsetPx: ratio * maxOffset,
    thumbSizePx,
  };
}

export function fileTabStripScrollLeftFromOverlay(
  thumbOffsetPx: number,
  thumbSizePx: number,
  trackWidth: number,
  scrollWidth: number,
  clientWidth: number,
): number {
  const overflow = Math.max(0, scrollWidth - clientWidth);
  const maxOffset = Math.max(0, trackWidth - thumbSizePx);
  if (overflow <= 0 || maxOffset <= 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, thumbOffsetPx / maxOffset));
  return ratio * overflow;
}

export function fileTabStripScrollLeftFromTrackClick(
  clickX: number,
  thumbSizePx: number,
  trackWidth: number,
  scrollWidth: number,
  clientWidth: number,
): number {
  return fileTabStripScrollLeftFromOverlay(
    clickX - thumbSizePx / 2,
    thumbSizePx,
    trackWidth,
    scrollWidth,
    clientWidth,
  );
}
