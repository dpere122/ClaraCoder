import { describe, expect, it } from 'vitest';
import {
  NO_WORKSPACE_SYSTEM_PROMPT_ID,
  isNoWorkspaceSystemPromptId,
  resolveSystemPromptStorageId,
} from './workspace';

describe('no-workspace system prompt id', () => {
  it('maps empty or null workspace ids to the reserved storage id', () => {
    expect(resolveSystemPromptStorageId(null)).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
    expect(resolveSystemPromptStorageId('')).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
    expect(resolveSystemPromptStorageId('   ')).toBe(NO_WORKSPACE_SYSTEM_PROMPT_ID);
  });

  it('keeps a real workspace id unchanged', () => {
    expect(resolveSystemPromptStorageId('ws-123')).toBe('ws-123');
  });

  it('treats empty and reserved ids as no-workspace', () => {
    expect(isNoWorkspaceSystemPromptId(null)).toBe(true);
    expect(isNoWorkspaceSystemPromptId('')).toBe(true);
    expect(isNoWorkspaceSystemPromptId(NO_WORKSPACE_SYSTEM_PROMPT_ID)).toBe(true);
    expect(isNoWorkspaceSystemPromptId('ws-123')).toBe(false);
  });
});
