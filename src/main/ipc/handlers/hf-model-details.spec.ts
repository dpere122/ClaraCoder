import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHfOwnerCacheForTests, fetchHfModelDetails, hfRepoPath, parseHfModelDetails } from './hf-model-details';

const REPO = {
  id: 'unsloth/Qwen3.8-27B-GGUF',
  author: 'unsloth',
  downloads: 6272560,
  likes: 5453,
  createdAt: '2026-08-13T08:28:40.000Z',
  lastModified: '2026-08-20T12:04:25.000Z',
  gated: false,
  private: false,
  usedStorage: 1053655307648,
  cardData: { base_model: ['Qwen/Qwen3.8-27B'], license: 'apache-2.0' },
  gguf: { total: 27320697856, architecture: 'qwen35', context_length: 262144, chat_template: '…' },
  tags: ['gguf', 'qwen3_5', 'unsloth', 'base_model:Qwen/Qwen3.8-27B', 'license:apache-2.0', 'region:us', 'conversational'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => clearHfOwnerCacheForTests());

describe('hfRepoPath', () => {
  it('encodes each part and rejects ids that are not owner/name', () => {
    expect(hfRepoPath('org/model name')).toBeNull();
    expect(hfRepoPath('org/a/b')).toBeNull();
    expect(hfRepoPath('org/Qwen3.8-27B')).toBe('org/Qwen3.8-27B');
  });
});

describe('parseHfModelDetails', () => {
  it('maps card, GGUF header and tags to panel fields', () => {
    const d = parseHfModelDetails(REPO, REPO.id);
    expect(d).toMatchObject({
      author: 'unsloth',
      license: 'apache-2.0',
      baseModels: ['Qwen/Qwen3.8-27B'],
      architecture: 'qwen35',
      parameterCount: 27320697856,
      contextLength: 262144,
      gated: false,
      tags: ['qwen3_5', 'unsloth', 'conversational'],
    });
  });

  it('falls back to base_model tags and treats "auto" gating as gated', () => {
    const d = parseHfModelDetails(
      { gated: 'auto', tags: ['base_model:quantized:google/gemma-4-12B-it', 'base_model:google/gemma-4-12B-it'] },
      'x/y',
    );
    expect(d.baseModels).toEqual(['google/gemma-4-12B-it']);
    expect(d.gated).toBe(true);
    expect(d.author).toBe('x');
  });
});

describe('fetchHfModelDetails', () => {
  it('adds uploader and provider profiles, inlines avatars, and keeps the token off profile requests', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/models/unsloth/Qwen3.8-27B-GGUF')) {
        return json(REPO);
      }
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      if (u.endsWith('/api/organizations/unsloth/overview')) {
        return json({ name: 'unsloth', fullname: 'Unsloth AI', isVerified: true, numModels: 1494, avatarUrl: 'https://cdn-avatars.huggingface.co/u.png' });
      }
      if (u.endsWith('/api/organizations/Qwen/overview')) {
        return json({ name: 'Qwen', fullname: 'Qwen', avatarUrl: 'https://evil.example/a.png' });
      }
      if (u === 'https://cdn-avatars.huggingface.co/u.png') {
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      return json({}, 404);
    });
    const d = await fetchHfModelDetails(REPO.id, 'hf_secret', fetchImpl as unknown as typeof fetch);
    expect(d.uploader).toMatchObject({ fullname: 'Unsloth AI', kind: 'org', verified: true, numModels: 1494 });
    expect(d.uploader?.avatarDataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    // Avatars from other hosts are never fetched.
    expect(d.provider).toMatchObject({ name: 'Qwen', avatarDataUrl: null });
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('evil.example'))).toBe(false);
    const repoCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/api/models/'));
    expect((repoCall?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer hf_secret');
  });

  it('falls back to the user profile and reports repo lookup failures', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/models/bartowski/')) {
        return json({ ...REPO, id: 'bartowski/m', author: 'bartowski', cardData: {}, tags: [] });
      }
      if (u.endsWith('/api/users/bartowski/overview')) {
        return json({ fullname: 'Bartowski', numFollowers: 16580 });
      }
      return json({}, 404);
    });
    const d = await fetchHfModelDetails('bartowski/m', '', fetchImpl as unknown as typeof fetch);
    expect(d.uploader).toMatchObject({ name: 'bartowski', kind: 'user', numFollowers: 16580 });
    expect(d.provider).toBeNull();
    await expect(fetchHfModelDetails('nope/missing', '', fetchImpl as unknown as typeof fetch)).rejects.toThrow('(404)');
  });
});
