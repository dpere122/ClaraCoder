import { describe, expect, it } from 'vitest';
import { THEME_GROUP_CATEGORIES } from '@shared/theme';
import {
  SETTINGS_SUB_TAB_CATALOG,
  buildThemesSubTabs,
  initialSettingsTab,
  isSettingsTab,
  settingsTabFromHash,
  themesCategoryFromSubTabId,
  themesCategorySubTabId,
} from './settings-tabs';

describe('isSettingsTab', () => {
  it('accepts catalog ids', () => {
    expect(isSettingsTab('general')).toBe(true);
    expect(isSettingsTab('themes')).toBe(true);
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

describe('themes sub-tabs', () => {
  it('derives one pane per registry category between the fixed panes', () => {
    const tabs = buildThemesSubTabs([
      { id: 'chat', label: 'Chat' },
      { id: 'editor', label: 'Editor' },
    ]);
    expect(tabs.map((t) => t.id)).toEqual(['library', 'global', 'cat:chat', 'cat:editor', 'monaco', 'advanced']);
    expect(themesCategoryFromSubTabId('cat:chat')).toBe('chat');
    expect(themesCategoryFromSubTabId('library')).toBeNull();
    expect(themesCategorySubTabId('hitl')).toBe('cat:hitl');
  });

  it('the catalog entry follows the generated registry and General no longer has a theme pane', () => {
    const ids = SETTINGS_SUB_TAB_CATALOG.themes!.map((t) => t.id);
    for (const category of THEME_GROUP_CATEGORIES) {
      expect(ids).toContain(themesCategorySubTabId(category.id));
    }
    expect(SETTINGS_SUB_TAB_CATALOG.general!.map((t) => t.id)).not.toContain('themes');
  });
});
