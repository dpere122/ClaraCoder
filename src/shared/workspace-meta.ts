/** Workspace-local Clara metadata directory (hidden from the file tree). */
export const WORKSPACE_META_DIR = '.clara';

/** Pre-rename metadata directory. Migrated to {@link WORKSPACE_META_DIR} when safe. */
export const LEGACY_WORKSPACE_META_DIR = '.nemo';

export const WORKSPACE_SYSTEM_PROMPT_FILE = 'system-prompt.md';

export const WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH = `${WORKSPACE_META_DIR}/${WORKSPACE_SYSTEM_PROMPT_FILE}`;

export const WORKSPACE_BUILD_PLANS_DIR = 'build-plans';

export const WORKSPACE_BUILD_PLANS_REL_DIR = `${WORKSPACE_META_DIR}/${WORKSPACE_BUILD_PLANS_DIR}`;

export function isWorkspaceSystemPromptRelativePath(relativePath: string): boolean {
  const n = (relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return n === WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH;
}
