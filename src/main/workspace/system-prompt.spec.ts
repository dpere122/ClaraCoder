import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH } from '../../shared';

const testRoot = { dir: '' };

vi.mock('../paths', () => ({
  getLegacyAppDataSystemPromptPath: (workspaceId: string) =>
    join(testRoot.dir, 'app-data', 'workspaces', workspaceId, 'system-prompt.md'),
  getWorkspaceSystemPromptPath: (workspaceRoot: string) =>
    join(workspaceRoot, '.clara', 'system-prompt.md'),
}));

import {
  DEFAULT_WORKSPACE_SYSTEM_PROMPT,
  ensureWorkspaceSystemPrompt,
  readWorkspaceSystemPromptText,
} from './system-prompt';
import { migrateLegacyWorkspaceMetaDir } from './meta-dir';

describe('workspace system-prompt storage', () => {
  beforeEach(() => {
    testRoot.dir = mkdtempSync(join(tmpdir(), 'clara-sys-prompt-'));
  });

  afterEach(() => {
    rmSync(testRoot.dir, { recursive: true, force: true });
  });

  it('seeds the default prompt under .clara when missing', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(ws, { recursive: true });
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(true);
    expect(result.relativePath).toBe(WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH);
    expect(existsSync(result.absolutePath)).toBe(true);
    expect(readFileSync(result.absolutePath, 'utf8')).toBe(DEFAULT_WORKSPACE_SYSTEM_PROMPT);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe(DEFAULT_WORKSPACE_SYSTEM_PROMPT);
  });

  it('does not overwrite an existing workspace prompt file', async () => {
    const ws = join(testRoot.dir, 'project');
    const dest = join(ws, '.clara', 'system-prompt.md');
    mkdirSync(join(ws, '.clara'), { recursive: true });
    writeFileSync(dest, 'Keep me.', 'utf8');
    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(result.created).toBe(false);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Keep me.');
  });

  it('migrates leftover app-data prompt into .clara', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(ws, { recursive: true });
    const legacy = join(testRoot.dir, 'app-data', 'workspaces', 'ws-legacy', 'system-prompt.md');
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, 'Migrated prompt.', 'utf8');

    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-legacy');
    expect(result.created).toBe(true);
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Migrated prompt.');
  });

  it('returns empty text when no file exists', async () => {
    const ws = join(testRoot.dir, 'empty');
    mkdirSync(ws, { recursive: true });
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('');
    await expect(readWorkspaceSystemPromptText('')).resolves.toBe('');
  });
});

describe('legacy .nemo metadata dir migration', () => {
  beforeEach(() => {
    testRoot.dir = mkdtempSync(join(tmpdir(), 'clara-meta-dir-'));
  });

  afterEach(() => {
    rmSync(testRoot.dir, { recursive: true, force: true });
  });

  it('renames .nemo to .clara and rewrites build-plan index paths', async () => {
    const ws = testRoot.dir;
    const plans = join(ws, '.nemo', 'build-plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'plan-abc.md'), '# Plan\n', 'utf8');
    writeFileSync(
      join(plans, 'index.json'),
      `${JSON.stringify(
        [{ id: 'plan-abc', relativePath: '.nemo/build-plans/plan-abc.md', status: 'active' }],
        null,
        2,
      )}\n`,
      'utf8',
    );

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.nemo'))).toBe(false);
    expect(existsSync(join(ws, '.clara', 'build-plans', 'plan-abc.md'))).toBe(true);
    const index = JSON.parse(readFileSync(join(ws, '.clara', 'build-plans', 'index.json'), 'utf8')) as Array<{
      relativePath: string;
    }>;
    expect(index[0]?.relativePath).toBe('.clara/build-plans/plan-abc.md');
  });

  it('leaves .nemo in place when .clara already exists', async () => {
    const ws = testRoot.dir;
    mkdirSync(join(ws, '.nemo', 'build-plans'), { recursive: true });
    mkdirSync(join(ws, '.clara', 'build-plans'), { recursive: true });
    writeFileSync(join(ws, '.nemo', 'build-plans', 'old.md'), 'legacy', 'utf8');
    writeFileSync(join(ws, '.clara', 'build-plans', 'keep.md'), 'keep', 'utf8');
    writeFileSync(
      join(ws, '.nemo', 'build-plans', 'index.json'),
      `${JSON.stringify(
        [
          { id: 'plan-old', relativePath: '.nemo/build-plans/old.md', status: 'active' },
          { id: 'shared', relativePath: '.nemo/build-plans/old.md', status: 'legacy' },
        ],
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(ws, '.clara', 'build-plans', 'index.json'),
      `${JSON.stringify(
        [
          { id: 'plan-new', relativePath: '.clara/build-plans/keep.md', status: 'active' },
          { id: 'shared', relativePath: '.clara/build-plans/keep.md', status: 'current' },
        ],
        null,
        2,
      )}\n`,
      'utf8',
    );

    await migrateLegacyWorkspaceMetaDir(ws);

    expect(existsSync(join(ws, '.nemo', 'build-plans', 'old.md'))).toBe(true);
    expect(existsSync(join(ws, '.clara', 'build-plans', 'old.md'))).toBe(true);
    expect(readFileSync(join(ws, '.clara', 'build-plans', 'keep.md'), 'utf8')).toBe('keep');
    const index = JSON.parse(readFileSync(join(ws, '.clara', 'build-plans', 'index.json'), 'utf8')) as Array<{
      id: string;
      relativePath: string;
      status: string;
    }>;
    const byId = Object.fromEntries(index.map((e) => [e.id, e]));
    expect(byId['plan-old']?.relativePath).toBe('.clara/build-plans/old.md');
    expect(byId['plan-new']?.relativePath).toBe('.clara/build-plans/keep.md');
    expect(byId['shared']?.status).toBe('current');
    expect(byId['shared']?.relativePath).toBe('.clara/build-plans/keep.md');
  });

  it('copies system-prompt.md from .nemo when .clara already exists without it', async () => {
    const ws = join(testRoot.dir, 'project');
    mkdirSync(join(ws, '.nemo'), { recursive: true });
    mkdirSync(join(ws, '.clara'), { recursive: true });
    writeFileSync(join(ws, '.nemo', 'system-prompt.md'), 'Legacy workspace prompt.', 'utf8');

    const result = await ensureWorkspaceSystemPrompt(ws, 'ws-1');
    expect(readFileSync(result.absolutePath, 'utf8')).toBe('Legacy workspace prompt.');
    await expect(readWorkspaceSystemPromptText(ws)).resolves.toBe('Legacy workspace prompt.');
  });
});
