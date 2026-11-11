/**
 * Claude API key storage. The key is kept out of ``config.json`` and out of every renderer:
 * main encrypts it with the OS keychain (Electron ``safeStorage``) into its own file, and only
 * main reads it back, to list models and to hand it to the Python sidecar for chat.
 *
 * When the keychain is unavailable the key is held in memory for this run only; it is never
 * written to disk as plaintext.
 */
import { promises as fs } from 'fs';
import path = require('path');
import type { AnthropicKeyStorage } from '../shared';
import { getAppDataDir } from './paths';

const KEY_FILE_NAME = 'anthropic-api-key.bin';

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (blob: Buffer) => string;
};

function tryGetSafeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    const ss = electron?.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      return ss;
    }
  } catch {
    // Vitest / non-Electron hosts.
  }
  return null;
}

let cachedKey: string | null = null;
let cachedStorage: AnthropicKeyStorage = 'none';
let loaded = false;
let keyFilePathOverride: string | null = null;
let safeStorageOverride: SafeStorageLike | null | undefined;

function keyFilePath(): string {
  return keyFilePathOverride ?? path.join(getAppDataDir(), 'secrets', KEY_FILE_NAME);
}

function safeStorage(): SafeStorageLike | null {
  return safeStorageOverride !== undefined ? safeStorageOverride : tryGetSafeStorage();
}

/** Test hook: point the store at a temp file and a fake keychain, and forget the cached key. */
export function configureAnthropicKeyStoreForTests(opts: {
  filePath: string | null;
  safeStorage?: SafeStorageLike | null;
}): void {
  keyFilePathOverride = opts.filePath;
  safeStorageOverride = opts.safeStorage;
  cachedKey = null;
  cachedStorage = 'none';
  loaded = false;
}

async function loadOnce(): Promise<void> {
  if (loaded) {
    return;
  }
  loaded = true;
  let blob: Buffer;
  try {
    blob = await fs.readFile(keyFilePath());
  } catch {
    return;
  }
  const ss = safeStorage();
  if (!ss) {
    console.warn('[anthropic] OS keychain unavailable; the saved Claude API key cannot be decrypted.');
    return;
  }
  try {
    const key = ss.decryptString(blob).trim();
    if (key) {
      cachedKey = key;
      cachedStorage = 'keychain';
    }
  } catch {
    console.warn('[anthropic] Saved Claude API key could not be decrypted; set it again in Settings.');
  }
}

/** The stored key, or ``''`` when none is set. Main process only. */
export async function getAnthropicApiKey(): Promise<string> {
  await loadOnce();
  return cachedKey ?? '';
}

export async function getAnthropicKeyStorage(): Promise<AnthropicKeyStorage> {
  await loadOnce();
  return cachedKey ? cachedStorage : 'none';
}

/** ``sk-ant-…abcd``: enough to tell keys apart, never enough to use one. */
export function anthropicKeyHint(key: string): string {
  const k = key.trim();
  if (!k) {
    return '';
  }
  const tail = k.length > 8 ? k.slice(-4) : '';
  const head = k.startsWith('sk-ant-') ? 'sk-ant-' : '';
  return `${head}…${tail}`;
}

/** Encrypt and persist the key (or keep it in memory when the keychain is unavailable). */
export async function setAnthropicApiKey(key: string): Promise<AnthropicKeyStorage> {
  await loadOnce();
  const k = key.trim();
  if (!k) {
    await clearAnthropicApiKey();
    return 'none';
  }
  const ss = safeStorage();
  const file = keyFilePath();
  if (ss) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, ss.encryptString(k), { mode: 0o600 });
    await fs.rename(temp, file);
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // Best-effort on platforms that ignore mode bits.
    }
    cachedStorage = 'keychain';
  } else {
    // Never persist plaintext; drop any stale ciphertext so a later run cannot pick up an old key.
    await fs.rm(file, { force: true });
    cachedStorage = 'session';
  }
  cachedKey = k;
  return cachedStorage;
}

export async function clearAnthropicApiKey(): Promise<void> {
  loaded = true;
  cachedKey = null;
  cachedStorage = 'none';
  await fs.rm(keyFilePath(), { force: true });
}
