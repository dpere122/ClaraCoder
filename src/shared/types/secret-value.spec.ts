/**
 * Tests for security/config-secrets — the SecretValue wrapper and helpers.
 *
 * SecretValue<T> is an opaque wrapper around secret strings:
 * - toJSON / util.inspect → '[REDACTED]' (safe logs / accidental serialization)
 * - toString / valueOf / Symbol.toPrimitive → underlying string (transparent coercion)
 * - unwrap() → underlying string for trusted sinks
 */
import { describe, it, expect } from 'vitest';
import * as util from 'util';

import {
  SecretValue,
  isSecretValue,
  unwrapSecret,
  coerceSecretValue,
} from './app-config';

describe('SecretValue.of / unwrap', () => {
  it('wraps a plaintext string and unwraps it', () => {
    const sv = SecretValue.of('sk-SECRET-123');
    expect(sv.unwrap()).toBe('sk-SECRET-123');
  });

  it('of(null/undefined) wraps an empty string', () => {
    expect(SecretValue.of(null).unwrap()).toBe('');
    expect(SecretValue.of(undefined).unwrap()).toBe('');
  });

  it('of(existing SecretValue) returns the same instance', () => {
    const sv = SecretValue.of('x');
    expect(SecretValue.of(sv)).toBe(sv);
  });
});

describe('SecretValue transparent coercion', () => {
  it('toString / valueOf / String() yield the underlying string', () => {
    const sv = SecretValue.of('sk-PLAIN');
    expect(sv.toString()).toBe('sk-PLAIN');
    expect(sv.valueOf()).toBe('sk-PLAIN');
    expect(String(sv)).toBe('sk-PLAIN');
  });

  it('string concatenation coerces to the underlying string', () => {
    const sv = SecretValue.of('sk-PLAIN');
    expect(sv + 'suffix').toBe('sk-PLAINsuffix');
    expect(`pre-${sv}`).toBe('pre-sk-PLAIN');
  });
});

describe('SecretValue redaction', () => {
  it('toJSON returns [REDACTED]', () => {
    expect(SecretValue.of('sk-PLAIN').toJSON()).toBe('[REDACTED]');
  });

  it('JSON.stringify of an object holding a SecretValue redacts it', () => {
    const obj = { apiKey: SecretValue.of('sk-PLAIN') };
    expect(JSON.stringify(obj)).toBe('{"apiKey":"[REDACTED]"}');
  });

  it('util.inspect returns [REDACTED]', () => {
    const sv = SecretValue.of('sk-PLAIN');
    expect(util.inspect(sv)).toBe('[REDACTED]');
  });

  it('JSON.stringify of the SecretValue itself redacts', () => {
    expect(JSON.stringify(SecretValue.of('sk-PLAIN'))).toBe('"[REDACTED]"');
  });
});

describe('isSecretValue', () => {
  it('true for a SecretValue instance', () => {
    expect(isSecretValue(SecretValue.of('x'))).toBe(true);
  });

  it('false for a plain string', () => {
    expect(isSecretValue('plain')).toBe(false);
  });

  it('false for null / undefined / number', () => {
    expect(isSecretValue(null)).toBe(false);
    expect(isSecretValue(undefined)).toBe(false);
    expect(isSecretValue(123)).toBe(false);
  });
});

describe('unwrapSecret', () => {
  it('unwraps a SecretValue', () => {
    expect(unwrapSecret(SecretValue.of('sk-PLAIN'))).toBe('sk-PLAIN');
  });

  it('passes through a plain string', () => {
    expect(unwrapSecret('plain')).toBe('plain');
  });

  it('returns empty string for null / undefined', () => {
    expect(unwrapSecret(null)).toBe('');
    expect(unwrapSecret(undefined)).toBe('');
  });
});

describe('coerceSecretValue', () => {
  it('wraps a plain string', () => {
    expect(coerceSecretValue('sk-PLAIN').unwrap()).toBe('sk-PLAIN');
  });

  it('returns the same instance for an existing SecretValue', () => {
    const sv = SecretValue.of('x');
    expect(coerceSecretValue(sv)).toBe(sv);
  });

  it('wraps null/undefined as empty SecretValue', () => {
    expect(coerceSecretValue(null).unwrap()).toBe('');
    expect(coerceSecretValue(undefined).unwrap()).toBe('');
  });

  it('preserves non-string material as a stringified SecretValue', () => {
    expect(coerceSecretValue(123).unwrap()).toBe('123');
  });
});
