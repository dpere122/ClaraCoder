import { describe, expect, it } from 'vitest';
import { isBlobLikeFileName, looksLikeHubRepoLayout } from './hub-repo-layout';

describe('isBlobLikeFileName', () => {
  it('matches 64-char hex etags used as Hub blob names', () => {
    expect(isBlobLikeFileName('a'.repeat(64))).toBe(true);
    expect(isBlobLikeFileName(`sha256-${'b'.repeat(64)}`)).toBe(true);
  });

  it('rejects real model filenames', () => {
    expect(isBlobLikeFileName('model-Q4_K_M.gguf')).toBe(false);
    expect(isBlobLikeFileName('models--org--repo')).toBe(false);
  });
});

describe('looksLikeHubRepoLayout', () => {
  const full = { blobs: true, refs: true, snapshots: true };
  const claraDownload = { blobs: true, refs: false, snapshots: true };

  it('matches models-- prefix even without inner dirs', () => {
    expect(looksLikeHubRepoLayout('models--org--repo', { blobs: false, refs: false, snapshots: false })).toBe(
      true,
    );
  });

  it('matches Clara downloads after a rename drops models--', () => {
    expect(looksLikeHubRepoLayout('my-qwen', claraDownload)).toBe(true);
  });

  it('matches official Hub caches with refs', () => {
    expect(looksLikeHubRepoLayout('my-qwen', full)).toBe(true);
  });

  it('rejects a random folder', () => {
    expect(looksLikeHubRepoLayout('ggufs', { blobs: false, refs: false, snapshots: false })).toBe(false);
  });

  it('rejects blobs-only trees so loose files are not swallowed', () => {
    expect(looksLikeHubRepoLayout('my-qwen', { blobs: true, refs: false, snapshots: false })).toBe(false);
  });
});
