import { describe, expect, it } from 'vitest';
import {
  defaultSubagentsConfig,
  newSubagentRole,
  normalizeSubagentsConfig,
  subagentThinkingLevelOptions,
} from './subagents-config';

describe('subagentThinkingLevelOptions', () => {
  const ids = (preset?: string, offered?: string[] | null) =>
    subagentThinkingLevelOptions(preset, offered).map((level) => level.id);

  it('offers what the model accepts', () => {
    expect(ids('generic')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(ids(undefined)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(ids('qwen')).toEqual(['low', 'medium', 'xhigh']);
    // Thinking is only on or off there.
    expect(ids('gemma')).toEqual([]);
    // A list the source reports wins, in the catalog's order, without levels Settings does not know.
    expect(ids('generic', ['max', 'low', 'high', 'turbo'])).toEqual(['low', 'high', 'max']);
    expect(ids('generic', [])).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});

describe('normalizeSubagentsConfig', () => {
  it('returns the defaults for missing or malformed settings', () => {
    expect(normalizeSubagentsConfig(undefined)).toEqual(defaultSubagentsConfig());
    expect(normalizeSubagentsConfig('nope')).toEqual(defaultSubagentsConfig());
    expect(normalizeSubagentsConfig({ roles: 'x', cloudConcurrency: 'many', fallback: 'explode' })).toEqual(
      defaultSubagentsConfig(),
    );
  });

  it('clamps the cloud limit and keeps a valid fallback', () => {
    expect(normalizeSubagentsConfig({ cloudConcurrency: 99 }).cloudConcurrency).toBe(16);
    expect(normalizeSubagentsConfig({ cloudConcurrency: 0 }).cloudConcurrency).toBe(1);
    expect(normalizeSubagentsConfig({ cloudConcurrency: 4.4, fallback: 'fail', enabled: false })).toMatchObject({
      cloudConcurrency: 4,
      fallback: 'fail',
      enabled: false,
    });
  });

  it('keeps valid roles in order and is stable on its own output', () => {
    const role = { ...newSubagentRole('r1', 'explorer'), connectionId: 'src', readOnly: true, tools: ['search', 'read'] };
    const once = normalizeSubagentsConfig({ roles: [role, newSubagentRole('r2', 'worker')] });
    expect(once.roles.map((r) => r.name)).toEqual(['explorer', 'worker']);
    // Tool groups come back in catalog order.
    expect(once.roles[0]).toMatchObject({ connectionId: 'src', readOnly: true, tools: ['read', 'search'] });
    expect(once.roles.map((r) => r.thinking)).toEqual(['source', 'source']);
    expect(normalizeSubagentsConfig(once)).toEqual(once);
  });

  it('drops roles without an id or name and repeated ids or names', () => {
    const { roles } = normalizeSubagentsConfig({
      roles: [
        newSubagentRole('r1', '  explorer   one '),
        newSubagentRole('r2', 'Explorer One'),
        newSubagentRole('r1', 'other'),
        newSubagentRole('', 'nameless id'),
        newSubagentRole('r5', '   '),
        null,
      ],
    });
    expect(roles.map((r) => [r.id, r.name])).toEqual([['r1', 'explorer one']]);
  });

  it('keeps a thinking setting and defaults anything else to the source', () => {
    const { roles } = normalizeSubagentsConfig({
      roles: [
        { ...newSubagentRole('r1', 'quiet'), thinking: 'off' },
        { ...newSubagentRole('r2', 'deep'), thinking: 'on' },
        { ...newSubagentRole('r3', 'odd'), thinking: 'maximum' },
        { id: 'r4', name: 'older', description: '' },
      ],
    });
    expect(roles.map((r) => r.thinking)).toEqual(['off', 'on', 'source', 'source']);
  });

  it('keeps a known thinking level and defaults anything else to the source', () => {
    const { roles } = normalizeSubagentsConfig({
      roles: [
        { ...newSubagentRole('r1', 'light'), thinkingLevel: 'low' },
        { ...newSubagentRole('r2', 'odd'), thinkingLevel: 'ludicrous' },
        { id: 'r3', name: 'older' },
      ],
    });
    expect(roles.map((r) => r.thinkingLevel)).toEqual(['low', '', '']);
  });

  it('strips backticks from names and unknown tool groups', () => {
    const { roles } = normalizeSubagentsConfig({
      roles: [{ ...newSubagentRole('r1', '`scout`'), tools: ['read', 'teleport'] }],
    });
    expect(roles[0]).toMatchObject({ name: 'scout', tools: ['read'] });
  });
});
