import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readlinkSync: vi.fn(),
}));

import { readlinkSync } from 'fs';
import { readPtyProcessCwd } from './pty-process-cwd';

describe('readPtyProcessCwd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for invalid pids', () => {
    expect(readPtyProcessCwd(0)).toBeNull();
    expect(readPtyProcessCwd(-1)).toBeNull();
    expect(readPtyProcessCwd(1.5)).toBeNull();
  });

  it('reads /proc/<pid>/cwd on linux', () => {
    if (process.platform !== 'linux') {
      expect(readPtyProcessCwd(42)).toBeNull();
      expect(readlinkSync).not.toHaveBeenCalled();
      return;
    }
    vi.mocked(readlinkSync).mockReturnValue('/tmp/ClaraCoder');
    expect(readPtyProcessCwd(42)).toBe('/tmp/ClaraCoder');
    expect(readlinkSync).toHaveBeenCalledWith('/proc/42/cwd');
  });

  it('returns null when the proc link is missing', () => {
    if (process.platform !== 'linux') {
      return;
    }
    vi.mocked(readlinkSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readPtyProcessCwd(42)).toBeNull();
  });
});
