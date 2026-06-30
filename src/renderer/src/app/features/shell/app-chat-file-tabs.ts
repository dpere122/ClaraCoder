import { normalizePathSlashes } from '../../utils/workspace-relative-path';
import {
  editorModelKeyForAbsolutePath,
  editorModelKeyForRelativePath,
  type OpenEditorFileRef,
  openEditorFileRefFromRelativePath,
} from '../workspace/open-editor-file-ref';

export interface ChatFileTab {
  /** Workspace-relative path when the file lives in the open workspace. */
  relativePath?: string;
  /** Absolute on-disk path when the tab is external (outside workspace). */
  absolutePath?: string;
  /** True when editing a file outside the workspace root. */
  outsideWorkspace?: boolean;
  /** Build plan id when this tab shows a `.nemo/build-plans/` markdown file. */
  buildPlanId?: string;
  /** True while the plan awaits confirm or is executing; closing tab cancels the plan. */
  buildPlanActive?: boolean;
  /** Preview-only markdown tab (no edit/preview toggle). */
  previewOnly?: boolean;
}

export function chatFileTabModelKey(tab: ChatFileTab): string {
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
  const key = chatFileTabModelKey(tab);
  return key ? `file:${key}` : 'file:';
}

export function chatFileTabBasename(tab: ChatFileTab): string {
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

export { openEditorFileRefFromRelativePath };
