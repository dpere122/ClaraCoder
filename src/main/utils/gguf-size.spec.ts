import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ggufBytesOnDisk } from './gguf-size';

describe('ggufBytesOnDisk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gguf-size-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a single file', async () => {
    const file = path.join(dir, 'model.gguf');
    writeFileSync(file, Buffer.alloc(10));
    await expect(ggufBytesOnDisk(file)).resolves.toBe(10);
  });

  it('adds up every shard of a split model from the first one', async () => {
    writeFileSync(path.join(dir, 'model-00001-of-00003.gguf'), Buffer.alloc(10));
    writeFileSync(path.join(dir, 'model-00002-of-00003.gguf'), Buffer.alloc(20));
    writeFileSync(path.join(dir, 'model-00003-of-00003.gguf'), Buffer.alloc(30));
    await expect(ggufBytesOnDisk(path.join(dir, 'model-00001-of-00003.gguf'))).resolves.toBe(60);
  });

  it('rejects when a shard is missing, so the caller falls back', async () => {
    writeFileSync(path.join(dir, 'model-00001-of-00002.gguf'), Buffer.alloc(10));
    await expect(ggufBytesOnDisk(path.join(dir, 'model-00001-of-00002.gguf'))).rejects.toThrow();
  });
});
