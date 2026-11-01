import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';

vi.mock('./paths', () => ({ getAppDataDir: () => process.env.CLARA_TEST_APPDATA ?? '' }));

import {
  anthropicKeyHint,
  clearAnthropicApiKey,
  configureAnthropicKeyStoreForTests,
  getAnthropicApiKey,
  getAnthropicKeyStorage,
  setAnthropicApiKey,
} from './anthropic-key-store';
import { getAnthropicStatus, parseAnthropicModel, setAnthropicClientFactoryForTests } from './anthropic-models';
import { anthropicReasoningCaps } from '../shared';

const leaf = (supported: boolean) => ({ supported });

function modelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'claude-opus-5-5',
    type: 'model',
    display_name: 'Claude Opus 5.5',
    created_at: '2026-09-01T00:00:00Z',
    deprecated_at: null,
    lifecycle: 'active',
    line: 'opus',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    retires_at: null,
    capabilities: {
      image_input: leaf(true),
      structured_outputs: leaf(true),
      thinking: {
        supported: true,
        types: { adaptive: leaf(true), enabled: leaf(false), disabled: leaf(false), between_tools: leaf(false) },
      },
      effort: {
        supported: true,
        low: leaf(true),
        medium: leaf(true),
        high: leaf(true),
        xhigh: leaf(true),
        max: leaf(true),
      },
    } as unknown as ModelInfo['capabilities'],
    ...overrides,
  } as ModelInfo;
}

/** Fake keys built at runtime so no key-shaped literal sits in the source (secret scanners). */
const KEY_PREFIX = ['sk', 'ant'].join('-');
const FAKE_KEY = `${KEY_PREFIX}-fake-store-key-1234`;
const FAKE_GOOD_KEY = `${KEY_PREFIX}-fake-good-key-0001`;

/** Reversible stand-in for Electron safeStorage. */
const fakeKeychain = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
  decryptString: (blob: Buffer) => Buffer.from(blob.toString().slice(4), 'base64').toString(),
};

describe('parseAnthropicModel', () => {
  it('reads limits, line and capabilities from a Models API row', () => {
    const model = parseAnthropicModel(modelInfo());
    expect(model).toMatchObject({
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      line: 'opus',
      deprecated: false,
      vision: true,
      adaptiveThinking: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      structuredOutputs: true,
    });
    expect(anthropicReasoningCaps(model!)).toEqual({
      enableThinking: false,
      reasoningEffortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
      adaptiveThinking: true,
    });
  });

  it('drops retired models and keeps deprecated ones flagged', () => {
    expect(parseAnthropicModel(modelInfo({ lifecycle: 'retired' }))).toBeNull();
    expect(parseAnthropicModel(modelInfo({ lifecycle: 'deprecated' }))?.deprecated).toBe(true);
  });

  it('gives a model without effort no effort caps', () => {
    const info = modelInfo({ id: 'claude-haiku-4-5' });
    (info.capabilities as unknown as { effort: { supported: boolean } }).effort.supported = false;
    const model = parseAnthropicModel(info)!;
    expect(model.effortLevels).toEqual([]);
    expect(anthropicReasoningCaps(model).reasoningEffortValues).toBeNull();
  });
});

describe('anthropic key store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clara-claude-key-'));
    process.env.CLARA_TEST_APPDATA = dir;
  });

  afterEach(() => {
    configureAnthropicKeyStoreForTests({ filePath: null });
    setAnthropicClientFactoryForTests(null);
    delete process.env.CLARA_TEST_APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it('encrypts the key on disk and reads it back after a restart', async () => {
    const file = join(dir, 'secrets', 'anthropic-api-key.bin');
    configureAnthropicKeyStoreForTests({ filePath: file, safeStorage: fakeKeychain });
    expect(await setAnthropicApiKey(FAKE_KEY)).toBe('keychain');
    expect(readFileSync(file).toString()).not.toContain(FAKE_KEY);

    configureAnthropicKeyStoreForTests({ filePath: file, safeStorage: fakeKeychain });
    expect(await getAnthropicApiKey()).toBe(FAKE_KEY);
    expect(await getAnthropicKeyStorage()).toBe('keychain');

    await clearAnthropicApiKey();
    configureAnthropicKeyStoreForTests({ filePath: file, safeStorage: fakeKeychain });
    expect(await getAnthropicApiKey()).toBe('');
  });

  it('keeps the key in memory only when the keychain is unavailable', async () => {
    const file = join(dir, 'secrets', 'anthropic-api-key.bin');
    configureAnthropicKeyStoreForTests({ filePath: file, safeStorage: null });
    expect(await setAnthropicApiKey(FAKE_KEY)).toBe('session');
    expect(await getAnthropicApiKey()).toBe(FAKE_KEY);
    expect(() => readFileSync(file)).toThrow();
  });

  it('hints a key without revealing it', () => {
    expect(anthropicKeyHint(`${KEY_PREFIX}-fake-hint-key-WXYZ`)).toBe(`${KEY_PREFIX}-…WXYZ`);
    expect(anthropicKeyHint('')).toBe('');
  });

  it('reports models for a good key and a readable error for a rejected one', async () => {
    configureAnthropicKeyStoreForTests({ filePath: join(dir, 'k.bin'), safeStorage: fakeKeychain });
    await setAnthropicApiKey(FAKE_GOOD_KEY);
    setAnthropicClientFactoryForTests(() => ({
      models: {
        list: () =>
          (async function* () {
            yield modelInfo();
            yield modelInfo({ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', line: 'sonnet' });
          })(),
      },
    }) as unknown as Pick<Anthropic, 'models'>);
    const ok = await getAnthropicStatus(true);
    expect(ok.ok).toBe(true);
    expect(ok.status).toMatchObject({ configured: true, storage: 'keychain', keyHint: `${KEY_PREFIX}-…0001` });
    expect(ok.status.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(JSON.stringify(ok)).not.toContain('fake-good-key');

    setAnthropicClientFactoryForTests(() => ({
      models: {
        list: () =>
          (async function* () {
            throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
          })(),
      },
    }) as unknown as Pick<Anthropic, 'models'>);
    const bad = await getAnthropicStatus(true);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.error).toContain('rejected (401)');
    expect(bad.status.models).toEqual([]);
  });
});
