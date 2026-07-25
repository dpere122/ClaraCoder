import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = { dir: '' };

vi.mock('../paths', () => ({
  getWorkspaceDir: (workspaceId: string) => join(testRoot.dir, 'workspaces', workspaceId),
  getWorkspaceSystemPromptPath: (workspaceId: string) =>
    join(testRoot.dir, 'workspaces', workspaceId, 'system-prompt.md'),
}));

import {
  WORKSPACE_SYSTEM_PROMPT_MAX_BYTES,
  clearWorkspaceSystemPromptFile,
  copyWorkspaceSystemPromptFromPath,
  getWorkspaceSystemPromptStatus,
  readWorkspaceSystemPromptText,
  writeWorkspaceSystemPromptText,
} from './system-prompt';

describe('workspace system-prompt storage', () => {
  beforeEach(() => {
    testRoot.dir = mkdtempSync(join(tmpdir(), 'nemo-sys-prompt-'));
  });

  afterEach(() => {
    rmSync(testRoot.dir, { recursive: true, force: true });
  });

  it('copies a source file into the managed single copy and reports status', async () => {
    const source = join(testRoot.dir, 'notes.md');
    writeFileSync(source, 'Prefer pytest for this repo.', 'utf8');

    const { sourceName } = await copyWorkspaceSystemPromptFromPath('ws-1', source);
    expect(sourceName).toBe('notes.md');

    const managed = join(testRoot.dir, 'workspaces', 'ws-1', 'system-prompt.md');
    expect(existsSync(managed)).toBe(true);
    expect(readFileSync(managed, 'utf8')).toBe('Prefer pytest for this repo.');

    const status = await getWorkspaceSystemPromptStatus('ws-1', 'notes.md');
    expect(status).toEqual({ hasFile: true, sourceName: 'notes.md' });
    await expect(readWorkspaceSystemPromptText('ws-1')).resolves.toBe('Prefer pytest for this repo.');
  });

  it('overwrites the managed file on a second pick', async () => {
    const first = join(testRoot.dir, 'a.txt');
    const second = join(testRoot.dir, 'b.txt');
    writeFileSync(first, 'first', 'utf8');
    writeFileSync(second, 'second', 'utf8');

    await copyWorkspaceSystemPromptFromPath('ws-1', first);
    await copyWorkspaceSystemPromptFromPath('ws-1', second);

    await expect(readWorkspaceSystemPromptText('ws-1')).resolves.toBe('second');
    const status = await getWorkspaceSystemPromptStatus('ws-1', 'b.txt');
    expect(status.sourceName).toBe('b.txt');
  });

  it('rejects oversized files', async () => {
    const source = join(testRoot.dir, 'big.md');
    writeFileSync(source, 'x'.repeat(WORKSPACE_SYSTEM_PROMPT_MAX_BYTES + 1), 'utf8');
    await expect(copyWorkspaceSystemPromptFromPath('ws-1', source)).rejects.toThrow(/at most/);
  });

  it('clears the managed file', async () => {
    const source = join(testRoot.dir, 'a.md');
    writeFileSync(source, 'hello', 'utf8');
    await copyWorkspaceSystemPromptFromPath('ws-1', source);
    await clearWorkspaceSystemPromptFile('ws-1');
    expect(existsSync(join(testRoot.dir, 'workspaces', 'ws-1', 'system-prompt.md'))).toBe(false);
    const status = await getWorkspaceSystemPromptStatus('ws-1', 'a.md');
    expect(status).toEqual({ hasFile: false, sourceName: '' });
  });

  it('returns empty text when no managed file exists', async () => {
    mkdirSync(join(testRoot.dir, 'workspaces', 'ws-missing'), { recursive: true });
    await expect(readWorkspaceSystemPromptText('ws-missing')).resolves.toBe('');
  });

  it('writes edited text into the managed single copy', async () => {
    await writeWorkspaceSystemPromptText('ws-1', 'Edited in dialog.');
    await expect(readWorkspaceSystemPromptText('ws-1')).resolves.toBe('Edited in dialog.');
    const status = await getWorkspaceSystemPromptStatus('ws-1');
    expect(status.hasFile).toBe(true);
  });
});
