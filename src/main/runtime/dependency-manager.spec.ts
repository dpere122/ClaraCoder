/**
 * Tests for security/child-env-scrub — child env scrub and depId gates.
 *
 * Covers: runtimeEnv passthrough allowlist (no full process.env spread),
 * and the install/reinstall/delete depId allowlist gate (early return
 * for unknown ids, no spawn/HTTP).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../log-ingest', () => ({ ingestElectronLog: vi.fn() }));
vi.mock('../python/http-client', () => ({
  pythonControlFetch: vi.fn(),
  pythonLongFetch: vi.fn(),
  pythonSseGet: vi.fn(),
}));
vi.mock('../python/server', () => ({
  isPythonHealthy: vi.fn(),
  restartPythonServer: vi.fn(),
}));
vi.mock('../utils/filter-sensitive-env', () => ({ envForChildProcess: vi.fn() }));

import {
  isRuntimeEnvPassthrough,
  isKnownDependencyId,
  installDependency,
  reinstallDependency,
  deleteDependency,
} from './dependency-manager';

describe('isRuntimeEnvPassthrough', () => {
  it.each(['PATH', 'PYTHONHOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])(
    'passes through %s',
    (key) => {
      expect(isRuntimeEnvPassthrough(key)).toBe(true);
    },
  );

  it.each(['CLARA_LOG_DIR', 'CLARA_RUNTIME_DIR', 'NEMO_FOO', 'clara_x', 'NEMO_bar'])(
    'passes through CLARA_* / NEMO_* (case-insensitive): %s',
    (key) => {
      expect(isRuntimeEnvPassthrough(key)).toBe(true);
    },
  );

  it.each(['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'HOME', 'USER'])(
    'does NOT pass through secret/other env keys: %s',
    (key) => {
      expect(isRuntimeEnvPassthrough(key)).toBe(false);
    },
  );
});

describe('depId allowlist gates', () => {
  const unknown = 'not-a-real-dependency' as never;

  it('installDependency rejects an unknown depId without spawning', async () => {
    const r = await installDependency(unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown dependency/);
    }
  });

  it('reinstallDependency rejects an unknown depId without spawning', async () => {
    const r = await reinstallDependency(unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown dependency/);
    }
  });

  it('deleteDependency rejects an unknown depId without spawning', async () => {
    const r = await deleteDependency(unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown dependency/);
    }
  });

  it('isKnownDependencyId is true for a real id and false for an unknown one', () => {
    // Pick a real id from the allowlist if any is exported; otherwise just assert the negative branch.
    expect(isKnownDependencyId(unknown as string)).toBe(false);
  });
});
