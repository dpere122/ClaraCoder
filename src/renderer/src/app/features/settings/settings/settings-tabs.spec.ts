import { describe, expect, it } from 'vitest';
import { initialSettingsTab, isSettingsTab, settingsTabFromHash } from './settings-tabs';

describe('isSettingsTab', () => {
  it('accepts catalog ids', () => {
    expect(isSettingsTab('general')).toBe(true);
    expect(isSettingsTab('modelManager')).toBe(true);
    expect(isSettingsTab('monaco')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isSettingsTab('help')).toBe(false);
    expect(isSettingsTab('')).toBe(false);
    expect(isSettingsTab(null)).toBe(false);
  });
});

describe('settingsTabFromHash', () => {
  it('reads a valid tab query from an Angular hash', () => {
    expect(settingsTabFromHash('#/settings?tab=audio')).toBe('audio');
    expect(settingsTabFromHash('/settings?tab=tools')).toBe('tools');
  });

  it('returns null when the tab is missing or unknown', () => {
    expect(settingsTabFromHash('#/settings')).toBeNull();
    expect(settingsTabFromHash('#/settings?tab=help')).toBeNull();
    expect(settingsTabFromHash('')).toBeNull();
  });
});

describe('initialSettingsTab', () => {
  it('uses a valid hash tab so the first paint is not Models', () => {
    expect(initialSettingsTab('#/settings?tab=audio')).toBe('audio');
  });

  it('defaults to models when the hash has no tab', () => {
    expect(initialSettingsTab('#/settings')).toBe('models');
    expect(initialSettingsTab('')).toBe('models');
  });
});
