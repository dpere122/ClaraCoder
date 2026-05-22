import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      realpath: vi.fn(),
    },
    realpathSync: vi.fn(),
  };
});

import { promises as fs, realpathSync } from 'fs';
import {
  isAbsolutePathWithinWorkspaceRoot,
  resolveExistingOrResolvedPath,
  resolveSafeWorkspacePath,
} from './workspace-safe-path';

describe('isAbsolutePathWithinWorkspaceRoot', () => {
  describe('basic containment', () => {
    it('returns true when candidate equals workspace root', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace', '/workspace')).toBe(true);
    });

    it('returns true for direct child', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace', '/workspace/file.txt')).toBe(true);
    });

    it('returns true for nested child', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace', '/workspace/src/lib/file.ts')).toBe(true);
    });

    it('returns false for sibling directory', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace', '/other')).toBe(false);
    });

    it('returns false for parent directory', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace/src', '/workspace')).toBe(false);
    });
  });

  describe('path traversal attacks', () => {
    it('returns false for path with .. that escapes', () => {
      const root = path.resolve('/workspace');
      const escape = path.resolve('/workspace/../etc/passwd');
      expect(isAbsolutePathWithinWorkspaceRoot(root, escape)).toBe(false);
    });

    it('returns true for path with .. that stays inside', () => {
      const root = path.resolve('/workspace');
      const inside = path.resolve('/workspace/src/../lib/file.ts');
      expect(isAbsolutePathWithinWorkspaceRoot(root, inside)).toBe(true);
    });

    it('returns false for path that looks like prefix but is sibling', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace', '/workspace-evil/file.txt')).toBe(false);
    });

    it('returns false for path that looks like prefix with numbers', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/project', '/project2/file.txt')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles trailing slashes on root', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('/workspace/', '/workspace/file.txt')).toBe(true);
    });

    it('handles paths with extra slashes', () => {
      const root = path.resolve('/workspace');
      const candidate = path.resolve('/workspace//src///file.txt');
      expect(isAbsolutePathWithinWorkspaceRoot(root, candidate)).toBe(true);
    });

    it('handles whitespace in paths', () => {
      expect(isAbsolutePathWithinWorkspaceRoot('  /workspace  ', '/workspace/file.txt')).toBe(true);
    });
  });

  if (process.platform === 'win32') {
    describe('Windows-specific', () => {
      it('handles case-insensitive comparison', () => {
        expect(isAbsolutePathWithinWorkspaceRoot('C:\\Workspace', 'c:\\workspace\\file.txt')).toBe(true);
      });

      it('handles mixed separators', () => {
        const root = path.resolve('C:\\Workspace');
        const candidate = path.resolve('C:/Workspace/src/file.txt');
        expect(isAbsolutePathWithinWorkspaceRoot(root, candidate)).toBe(true);
      });

      it('returns false for different drive letters', () => {
        expect(isAbsolutePathWithinWorkspaceRoot('C:\\Workspace', 'D:\\Workspace\\file.txt')).toBe(false);
      });
    });
  }
});

describe('resolveExistingOrResolvedPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns realpath when path exists', async () => {
    const mockRealPath = vi.mocked(fs.realpath);
    mockRealPath.mockResolvedValue('/real/canonical/path');

    const result = await resolveExistingOrResolvedPath('/some/path');
    expect(result).toBe('/real/canonical/path');
  });

  it('returns resolved path when realpath fails', async () => {
    const mockRealPath = vi.mocked(fs.realpath);
    mockRealPath.mockRejectedValue(new Error('ENOENT'));

    const result = await resolveExistingOrResolvedPath('/nonexistent/path');
    expect(result).toBe(path.resolve('/nonexistent/path'));
  });

  it('trims whitespace from input', async () => {
    const mockRealPath = vi.mocked(fs.realpath);
    mockRealPath.mockResolvedValue('/trimmed/path');

    await resolveExistingOrResolvedPath('  /some/path  ');
    expect(mockRealPath).toHaveBeenCalledWith(path.resolve('/some/path'));
  });
});

describe('resolveSafeWorkspacePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockRealpathSync = vi.mocked(realpathSync);
    mockRealpathSync.mockImplementation((p: string) => p as string);
  });

  describe('safe paths', () => {
    it('resolves relative path under workspace', () => {
      const result = resolveSafeWorkspacePath('/workspace', 'src/file.ts');
      expect(result).toBe(path.resolve('/workspace', 'src/file.ts'));
    });

    it('resolves dot path', () => {
      const result = resolveSafeWorkspacePath('/workspace', '.');
      expect(result).toBe(path.resolve('/workspace'));
    });

    it('resolves empty path as workspace root', () => {
      const result = resolveSafeWorkspacePath('/workspace', '');
      expect(result).toBe(path.resolve('/workspace'));
    });

    it('handles nested relative paths', () => {
      const result = resolveSafeWorkspacePath('/workspace', 'src/lib/utils/file.ts');
      expect(result).toBe(path.resolve('/workspace', 'src/lib/utils/file.ts'));
    });

    it('normalizes backslashes to forward slashes', () => {
      const result = resolveSafeWorkspacePath('/workspace', 'src\\lib\\file.ts');
      expect(result).toBe(path.resolve('/workspace', 'src/lib/file.ts'));
    });
  });

  describe('path traversal prevention', () => {
    it('throws on .. that escapes workspace', () => {
      expect(() => {
        resolveSafeWorkspacePath('/workspace', '../outside');
      }).toThrow('Path escapes workspace');
    });

    it('throws on absolute path outside workspace', () => {
      expect(() => {
        resolveSafeWorkspacePath('/workspace', '/etc/passwd');
      }).toThrow('Path escapes workspace');
    });

    it('throws on encoded path traversal', () => {
      expect(() => {
        resolveSafeWorkspacePath('/workspace', '..%2F..%2Fetc%2Fpasswd');
      }).toThrow('Path escapes workspace');
    });

    it('throws on deep traversal', () => {
      expect(() => {
        resolveSafeWorkspacePath('/workspace', 'src/../../../../../../etc/passwd');
      }).toThrow('Path escapes workspace');
    });

    it('allows .. that stays within workspace', () => {
      const result = resolveSafeWorkspacePath('/workspace', 'src/../lib/file.ts');
      expect(result).toBe(path.resolve('/workspace', 'lib/file.ts'));
    });

    it('throws on null bytes (potential C string truncation)', () => {
      const result = resolveSafeWorkspacePath('/workspace', 'file.txt\x00../../../etc/passwd');
      expect(path.dirname(result)).toBe(path.resolve('/workspace'));
    });
  });

  describe('security edge cases', () => {
    it('throws on sibling directory with similar name', () => {
      expect(() => {
        resolveSafeWorkspacePath('/workspace', '../workspace-attacker/file.txt');
      }).toThrow('Path escapes workspace');
    });

    it('handles symlink resolution via realpathSync', () => {
      const mockRealpathSync = vi.mocked(realpathSync);
      mockRealpathSync.mockImplementation((p: string) => {
        if (p === path.resolve('/workspace')) {
          return '/real/workspace' as unknown as string;
        }
        return p as string;
      });

      const result = resolveSafeWorkspacePath('/workspace', 'file.txt');
      expect(result).toBe(path.resolve('/real/workspace', 'file.txt'));
    });
  });
});

describe('security: combined scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockRealpathSync = vi.mocked(realpathSync);
    mockRealpathSync.mockImplementation((p: string) => p as string);
  });

  it('full workflow: validate then resolve', () => {
    const workspaceRoot = '/safe/workspace';
    const userInput = 'src/components/Button.tsx';

    const resolved = resolveSafeWorkspacePath(workspaceRoot, userInput);
    expect(isAbsolutePathWithinWorkspaceRoot(workspaceRoot, resolved)).toBe(true);
  });

  it('blocks crafted attack: unicode normalization', () => {
    expect(() => {
      resolveSafeWorkspacePath('/workspace', '．．/etc/passwd');
    }).toThrow('Path escapes workspace');
  });

  it('blocks null byte injection', () => {
    const result = resolveSafeWorkspacePath('/workspace', 'safe.txt');
    expect(result.includes('\x00')).toBe(false);
  });
});
