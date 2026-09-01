import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_META_DIR,
  WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
  isWorkspaceSystemPromptRelativePath,
} from './workspace-meta';

describe('workspace meta paths', () => {
  it('identifies the system prompt relative path', () => {
    expect(WORKSPACE_META_DIR).toBe('.clara');
    expect(isWorkspaceSystemPromptRelativePath(WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH)).toBe(true);
    expect(isWorkspaceSystemPromptRelativePath('.clara\\system-prompt.md')).toBe(true);
    expect(isWorkspaceSystemPromptRelativePath('src/app.ts')).toBe(false);
    expect(isWorkspaceSystemPromptRelativePath('.clara/other.md')).toBe(false);
  });
});
