import { describe, expect, it } from 'vitest';

import { keptCheckpointContextTokens, pythonHistoryFromMessages } from './python-history';

describe('pythonHistoryFromMessages', () => {
  it('keeps user and assistant rows only, with structured content', () => {
    expect(
      pythonHistoryFromMessages([
        { role: 'user', text: 'hi', id: 'u1', structuredContent: [{ type: 'text', text: 'hi' }] },
        { role: 'chain', label: 'x', text: 'y', state: 'complete', source: 'tool', statusId: 's' },
        { role: 'assistant', text: 'hello' },
      ]),
    ).toEqual([
      { role: 'user', message: 'hi', structuredContent: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('marks a reply that ended early so the model does not read it as finished', () => {
    expect(
      pythonHistoryFromMessages([
        { role: 'assistant', text: 'Partial', endedEarly: 'interrupted' },
        { role: 'assistant', text: 'Half', endedEarly: 'stopped' },
        { role: 'assistant', text: '', endedEarly: 'error' },
      ]),
    ).toEqual([
      { role: 'assistant', content: 'Partial\n\n[Interrupted by the user]' },
      { role: 'assistant', content: 'Half\n\n[Interrupted by the user]' },
      { role: 'assistant', content: '[This reply failed before it finished]' },
    ]);
  });
});

describe('keptCheckpointContextTokens', () => {
  it('reads the meter reading only from a load that kept the checkpoint', () => {
    expect(keptCheckpointContextTokens({ ok: true, kept_checkpoint: true, context_tokens: 1234.7 })).toBe(1234);
    expect(keptCheckpointContextTokens({ ok: true })).toBe(0);
    expect(keptCheckpointContextTokens({ ok: true, kept_checkpoint: true, context_tokens: 0 })).toBe(0);
    expect(keptCheckpointContextTokens({ ok: true, kept_checkpoint: false, context_tokens: 50 })).toBe(0);
    expect(keptCheckpointContextTokens(null)).toBe(0);
  });
});
