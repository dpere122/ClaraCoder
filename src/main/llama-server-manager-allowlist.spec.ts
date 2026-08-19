/**
 * Tests for security/llama-server-spawn — binary allowlist (realpath under
 * runtime/bin) and HF_TOKEN env scrub before optional reinjection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import * as os from 'os';

vi.mock('./python/workspace-sync', () => ({ syncRuntimeConfigToPython: vi.fn() }));
vi.mock('./runtime/dependency-manager', () => ({ rewriteManagedLlamaCommand: vi.fn() }));
vi.mock('./log-ingest', () => ({ ingestElectronLog: vi.fn() }));

let tempBinDir = '';
vi.mock('./paths', async () => {
  const actual = await vi.importActual('./paths');
  return { ...actual, getRuntimeBinDir: () => tempBinDir };
});

let diskHfToken = '';
vi.mock('./config/load-save', async () => {
  const actual = await vi.importActual('./config/load-save');
  return {
    ...actual,
    loadConfigSync: () => ({
      modelManager: { huggingFaceToken: diskHfToken, customModelsDir: '' },
    }),
  };
});

import {
  resolveAllowedManagedLlamaServerBinary,
  managedLlamaCommandToSpawnArgv,
  buildManagedLlamaSpawnEnv,
} from './llama-server-manager';

describe('resolveAllowedManagedLlamaServerBinary', () => {
  beforeEach(() => {
    tempBinDir = mkdtempSync(path.join(os.tmpdir(), 'clara-bin-'));
    mkdirSync(tempBinDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('accepts the managed llama-server binary under runtime/bin', () => {
    const bin = path.join(tempBinDir, 'llama-server');
    writeFileSync(bin, '#!/bin/sh\n');
    const r = resolveAllowedManagedLlamaServerBinary(bin);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(path.basename(r.bin)).toBe('llama-server');
    }
  });

  it('rejects a binary outside runtime/bin', () => {
    const outside = path.join(os.tmpdir(), 'evil-bin');
    writeFileSync(outside, '#!/bin/sh\n');
    try {
      const r = resolveAllowedManagedLlamaServerBinary(outside);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects a wrong basename even under runtime/bin', () => {
    const bin = path.join(tempBinDir, 'not-llama-server');
    writeFileSync(bin, '#!/bin/sh\n');
    const r = resolveAllowedManagedLlamaServerBinary(bin);
    expect(r.ok).toBe(false);
  });

  it('rejects a symlink inside runtime/bin that points outside', () => {
    const target = path.join(os.tmpdir(), 'outside-evil');
    writeFileSync(target, '#!/bin/sh\n');
    const link = path.join(tempBinDir, 'llama-server');
    try {
      symlinkSync(target, link);
      const r = resolveAllowedManagedLlamaServerBinary(link);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { force: true });
    }
  });

  it('accepts llama-server.exe on windows-style names', () => {
    const bin = path.join(tempBinDir, 'llama-server.exe');
    writeFileSync(bin, '');
    const r = resolveAllowedManagedLlamaServerBinary(bin);
    expect(r.ok).toBe(true);
  });
});

describe('managedLlamaCommandToSpawnArgv (tokenizer + allowlist)', () => {
  beforeEach(() => {
    tempBinDir = mkdtempSync(path.join(os.tmpdir(), 'clara-bin-'));
    writeFileSync(path.join(tempBinDir, 'llama-server'), '#!/bin/sh\n');
  });
  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('accepts a valid command and resolves the allowlisted binary', () => {
    const bin = path.join(tempBinDir, 'llama-server');
    const r = managedLlamaCommandToSpawnArgv(`${bin} -m model.gguf -c 2048`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(path.basename(r.bin)).toBe('llama-server');
      expect(r.args).toContain('-c');
      expect(r.args).toContain('2048');
    }
  });

  it('rejects a command whose binary is outside runtime/bin', () => {
    const outside = path.join(os.tmpdir(), 'evil-bin');
    writeFileSync(outside, '#!/bin/sh\n');
    try {
      const r = managedLlamaCommandToSpawnArgv(`${outside} http://x.evil`);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

const HF_KEYS = ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN'] as const;

describe('buildManagedLlamaSpawnEnv — HF_TOKEN scrub', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    tempBinDir = mkdtempSync(path.join(os.tmpdir(), 'clara-bin-'));
    mkdirSync(tempBinDir, { recursive: true });
    diskHfToken = '';
    for (const k of HF_KEYS) {
      saved[k] = process.env[k];
      process.env[k] = 'leak-from-parent';
    }
  });
  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
    for (const k of HF_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('does not inherit parent HF tokens when settings token is empty', () => {
    const env = buildManagedLlamaSpawnEnv({ modelManager: { huggingFaceToken: '' } } as never);
    for (const k of HF_KEYS) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('reinjects only the settings token, not the parent leak', () => {
    const env = buildManagedLlamaSpawnEnv({
      modelManager: { huggingFaceToken: 'set-from-settings' },
    } as never);
    expect(env.HF_TOKEN).toBe('set-from-settings');
    expect(env.HUGGING_FACE_HUB_TOKEN).toBe('set-from-settings');
    expect(env.HUGGINGFACE_HUB_TOKEN).toBeUndefined();
  });
});
