import { describe, expect, it, vi } from 'vitest';

vi.mock('../paths', () => ({ getWorkspaceStagingDir: vi.fn(() => '/staging') }));
vi.mock('../config/load-save', () => ({ loadConfig: vi.fn() }));
vi.mock('../python/workspace-sync', () => ({ syncWorkspaceContextToPython: vi.fn() }));
vi.mock('./system-prompt', () => ({ ensureWorkspaceSystemPrompt: vi.fn() }));
vi.mock('./emit-files-changed', () => ({ pushWorkspaceFilesChangedToRenderer: vi.fn() }));

import { shouldIncludeWorkspacePathInContextSync } from './watcher';

const included = (relativePath: string, rules: string[] = []): boolean =>
  shouldIncludeWorkspacePathInContextSync('/ws', relativePath, rules, false);

describe('which watched paths reach the backend', () => {
  it('passes what the tree lists', () => {
    expect(included('src/app.py')).toBe(true);
    expect(included('web/src/index.ts')).toBe(true);
  });

  it('drops what is under a folder the tree prunes, at any depth', () => {
    expect(included('api/.venv/Lib/site-packages/foo/__init__.py')).toBe(false);
    expect(included('.venv/Lib/foo.py')).toBe(false);
    expect(included('web/out/chunk.js', ['out/'])).toBe(false);
  });

  it('drops an ignored leaf', () => {
    expect(included('src/.env')).toBe(false);
    expect(included('src/out', ['out'])).toBe(false);
  });
});
