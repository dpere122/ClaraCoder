import { normalizePathSlashes } from '../../utils/workspace-relative-path';

/** Open file reference for Monaco model lifecycle (workspace or external). */
export interface OpenEditorFileRef {
  /** Stable key for Monaco model map (`rel:…` or `abs:…`). */
  modelKey: string;
  relativePath?: string;
  absolutePath?: string;
  outsideWorkspace?: boolean;
}

/** Prefix of read-only turn-diff tab keys (`turn-diff:<userMessageId>:<relativePath>`). */
export const TURN_DIFF_MODEL_KEY_PREFIX = 'turn-diff:';

export function turnDiffModelKey(userMessageId: string, relativePath: string): string {
  return `${TURN_DIFF_MODEL_KEY_PREFIX}${userMessageId}:${normalizePathSlashes(relativePath)}`;
}

export function isTurnDiffModelKey(modelKey: string | null | undefined): boolean {
  return !!modelKey?.startsWith(TURN_DIFF_MODEL_KEY_PREFIX);
}

export function editorModelKeyForRelativePath(relativePath: string): string {
  return `rel:${normalizePathSlashes(relativePath)}`;
}

export function editorModelKeyForAbsolutePath(absolutePath: string): string {
  return `abs:${normalizePathSlashes(absolutePath)}`;
}

export function relativePathFromModelKey(modelKey: string): string | null {
  if (modelKey.startsWith('rel:')) {
    return modelKey.slice(4);
  }
  return null;
}

export function absolutePathFromModelKey(modelKey: string): string | null {
  if (modelKey.startsWith('abs:')) {
    return modelKey.slice(4);
  }
  return null;
}

export function isExternalModelKey(modelKey: string): boolean {
  return modelKey.startsWith('abs:');
}

export function displayPathForModelKey(modelKey: string): string {
  return relativePathFromModelKey(modelKey) ?? absolutePathFromModelKey(modelKey) ?? modelKey;
}

export function openEditorFileRefFromRelativePath(relativePath: string): OpenEditorFileRef {
  const rel = normalizePathSlashes(relativePath);
  return { modelKey: editorModelKeyForRelativePath(rel), relativePath: rel, outsideWorkspace: false };
}

export function openEditorFileRefFromAbsolutePath(absolutePath: string): OpenEditorFileRef {
  const abs = absolutePath.trim();
  return {
    modelKey: editorModelKeyForAbsolutePath(abs),
    absolutePath: abs,
    outsideWorkspace: true,
  };
}
