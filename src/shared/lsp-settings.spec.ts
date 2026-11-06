import { describe, expect, it } from 'vitest';
import { LSP_MONACO_LANGUAGE_IDS, LSP_SEMANTIC_LEGEND_SERVER_IDS } from './lsp-registry';
import { LSP_SERVER_CATALOG, defaultLspServersSettings, normalizeLspServersSettings } from './lsp-settings';

describe('normalizeLspServersSettings', () => {
  it.each([undefined, null, 'x', 3, {}, { gdscript: 'x' }])('fills defaults for %j', (raw) => {
    expect(normalizeLspServersSettings(raw)).toEqual(defaultLspServersSettings());
  });

  it('keeps valid values', () => {
    const saved = {
      gdscript: {
        godotBinaryPath: 'C:/godot/godot.exe',
        allowEngineApiDump: true,
        diagnosticsProfile: 'strict',
        inlayTypeHints: false,
        inlayParameterHints: false,
        formatterCommand: 'fmt',
        formatterArgs: '--stdin',
      },
    };
    expect(normalizeLspServersSettings(saved)).toEqual(saved);
  });

  it('replaces a bad field and keeps the rest', () => {
    const { gdscript } = normalizeLspServersSettings({
      gdscript: { godotBinaryPath: 'godot', diagnosticsProfile: 'loud', inlayTypeHints: 'no' },
    });
    expect(gdscript.godotBinaryPath).toBe('godot');
    expect(gdscript.diagnosticsProfile).toBe('godot');
    expect(gdscript.inlayTypeHints).toBe(true);
  });

  it.each([undefined, 'true', 1, {}])('never treats %j as permission to run Godot', (value) => {
    expect(normalizeLspServersSettings({ gdscript: { allowEngineApiDump: value } }).gdscript.allowEngineApiDump).toBe(
      false,
    );
  });

  it('is off by default', () => {
    expect(defaultLspServersSettings().gdscript.allowEngineApiDump).toBe(false);
  });
});

describe('LSP_SERVER_CATALOG', () => {
  it('lists every integrated server', () => {
    expect(LSP_SERVER_CATALOG.map((server) => server.id).sort()).toEqual([...LSP_SEMANTIC_LEGEND_SERVER_IDS].sort());
    expect(LSP_MONACO_LANGUAGE_IDS.length).toBeGreaterThan(0);
  });

  it('only makes Godot editable for now', () => {
    expect(LSP_SERVER_CATALOG.filter((server) => server.editable).map((server) => server.id)).toEqual(['gdscript']);
  });
});
