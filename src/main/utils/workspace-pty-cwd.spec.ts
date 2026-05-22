import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('./workspace-safe-path', () => ({
  isAbsolutePathWithinWorkspaceRoot: vi.fn(),
  resolveExistingOrResolvedPath: vi.fn(),
}));

import { existsSync } from 'fs';
import { isAbsolutePathWithinWorkspaceRoot, resolveExistingOrResolvedPath } from './workspace-safe-path';
import { validateWorkspacePtyCwd } from './workspace-pty-cwd';

describe('validateWorkspacePtyCwd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('returns error when workspaceRoot is empty', async () => {
      const result = await validateWorkspacePtyCwd('', '/some/cwd');

      expect(result).toEqual({ ok: false, error: 'Workspace root is required' });
    });

    it('returns error when workspaceRoot is whitespace only', async () => {
      const result = await validateWorkspacePtyCwd('   ', '/some/cwd');

      expect(result).toEqual({ ok: false, error: 'Workspace root is required' });
    });

    it('returns error when cwd is empty', async () => {
      const result = await validateWorkspacePtyCwd('/workspace', '');

      expect(result).toEqual({ ok: false, error: 'Working directory is required' });
    });

    it('returns error when cwd is whitespace only', async () => {
      const result = await validateWorkspacePtyCwd('/workspace', '   ');

      expect(result).toEqual({ ok: false, error: 'Working directory is required' });
    });

    it('handles non-string workspaceRoot by coercing', async () => {
      const result = await validateWorkspacePtyCwd(null as unknown as string, '/cwd');

      expect(result).toEqual({ ok: false, error: 'Workspace root is required' });
    });

    it('handles non-string cwd by coercing', async () => {
      const result = await validateWorkspacePtyCwd('/workspace', undefined as unknown as string);

      expect(result).toEqual({ ok: false, error: 'Working directory is required' });
    });
  });

  describe('path existence validation', () => {
    it('returns error when cwd does not exist on disk', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/resolved/workspace')
        .mockResolvedValueOnce('/resolved/nonexistent');
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await validateWorkspacePtyCwd('/workspace', '/nonexistent');

      expect(result).toEqual({ ok: false, error: 'Invalid or missing workspace directory' });
    });

    it('validates both paths exist', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/resolved/workspace')
        .mockResolvedValueOnce('/resolved/cwd');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      await validateWorkspacePtyCwd('/workspace', '/workspace/subdir');

      expect(existsSync).toHaveBeenCalledWith('/resolved/cwd');
    });
  });

  describe('workspace containment validation', () => {
    it('returns error when cwd is outside workspace', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/resolved/workspace')
        .mockResolvedValueOnce('/outside/path');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(false);

      const result = await validateWorkspacePtyCwd('/workspace', '/outside');

      expect(result).toEqual({ ok: false, error: 'Working directory must be inside the open workspace' });
    });

    it('returns success when cwd is inside workspace', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/resolved/workspace')
        .mockResolvedValueOnce('/resolved/workspace/subdir');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      const result = await validateWorkspacePtyCwd('/workspace', '/workspace/subdir');

      expect(result).toEqual({ ok: true, cwdReal: '/resolved/workspace/subdir' });
    });

    it('calls isAbsolutePathWithinWorkspaceRoot with resolved paths', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/canonical/workspace')
        .mockResolvedValueOnce('/canonical/workspace/src');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      await validateWorkspacePtyCwd('/workspace', '/workspace/src');

      expect(isAbsolutePathWithinWorkspaceRoot).toHaveBeenCalledWith(
        '/canonical/workspace',
        '/canonical/workspace/src'
      );
    });
  });

  describe('security: path traversal prevention', () => {
    it('blocks cwd attempting path traversal', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/workspace')
        .mockResolvedValueOnce('/etc/passwd');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(false);

      const result = await validateWorkspacePtyCwd('/workspace', '../../../etc/passwd');

      expect(result.ok).toBe(false);
    });

    it('blocks symlink escape', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/workspace')
        .mockResolvedValueOnce('/outside/via/symlink');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(false);

      const result = await validateWorkspacePtyCwd('/workspace', '/workspace/symlink-to-outside');

      expect(result.ok).toBe(false);
    });

    it('allows legitimate nested directory', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/workspace')
        .mockResolvedValueOnce('/workspace/src/components');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      const result = await validateWorkspacePtyCwd('/workspace', '/workspace/src/components');

      expect(result).toEqual({ ok: true, cwdReal: '/workspace/src/components' });
    });
  });

  describe('edge cases', () => {
    it('handles workspace root with trailing slash', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/workspace')
        .mockResolvedValueOnce('/workspace/src');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      const result = await validateWorkspacePtyCwd('/workspace/', '/workspace/src');

      expect(result.ok).toBe(true);
    });

    it('handles cwd equal to workspace root', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/workspace')
        .mockResolvedValueOnce('/workspace');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      const result = await validateWorkspacePtyCwd('/workspace', '/workspace');

      expect(result).toEqual({ ok: true, cwdReal: '/workspace' });
    });

    it('returns resolved canonical path in success case', async () => {
      vi.mocked(resolveExistingOrResolvedPath)
        .mockResolvedValueOnce('/canonical/workspace')
        .mockResolvedValueOnce('/canonical/workspace/SRC');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockReturnValue(true);

      const result = await validateWorkspacePtyCwd('/workspace', '/workspace/src');

      expect(result).toEqual({ ok: true, cwdReal: '/canonical/workspace/SRC' });
    });
  });
});

describe('security: combined validation workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates in correct order: resolve, exist, contain', async () => {
    const callOrder: string[] = [];

    vi.mocked(resolveExistingOrResolvedPath).mockImplementation(async (p) => {
      callOrder.push(`resolve:${p}`);
      return `/resolved${p}`;
    });
    vi.mocked(existsSync).mockImplementation((p) => {
      callOrder.push(`exists:${p}`);
      return true;
    });
    vi.mocked(isAbsolutePathWithinWorkspaceRoot).mockImplementation((root, cand) => {
      callOrder.push(`contain:${root}:${cand}`);
      return true;
    });

    await validateWorkspacePtyCwd('/workspace', '/workspace/src');

    expect(callOrder[0]).toMatch(/^resolve:/);
    expect(callOrder[1]).toMatch(/^resolve:/);
    expect(callOrder[2]).toMatch(/^exists:/);
    expect(callOrder[3]).toMatch(/^contain:/);
  });

  it('short-circuits on existence check failure', async () => {
    vi.mocked(resolveExistingOrResolvedPath)
      .mockResolvedValueOnce('/workspace')
      .mockResolvedValueOnce('/workspace/nonexistent');
    vi.mocked(existsSync).mockReturnValue(false);

    await validateWorkspacePtyCwd('/workspace', '/workspace/nonexistent');

    expect(isAbsolutePathWithinWorkspaceRoot).not.toHaveBeenCalled();
  });
});
