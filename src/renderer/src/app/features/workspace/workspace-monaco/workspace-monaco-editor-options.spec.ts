import { describe, expect, it } from 'vitest';
import { defaultMonacoWorkspaceEditorSettings, normalizeMonacoWorkspaceEditorSettings } from '@shared/index';
import { monacoWorkspaceSettingsToEditorOptions } from './workspace-monaco-editor-options';

describe('monacoWorkspaceSettingsToEditorOptions gutter', () => {
  it('keeps the gutter compact', () => {
    const options = monacoWorkspaceSettingsToEditorOptions(defaultMonacoWorkspaceEditorSettings());
    expect(options.glyphMargin).toBe(false);
    expect(options.lineNumbersMinChars).toBe(3);
  });

  it('ignores a glyph margin saved by an older version', () => {
    const { settings } = normalizeMonacoWorkspaceEditorSettings({
      ...defaultMonacoWorkspaceEditorSettings(),
      glyphMargin: true,
    });
    expect(monacoWorkspaceSettingsToEditorOptions(settings).glyphMargin).toBe(false);
  });

  it('leaves line numbers and folding to the settings', () => {
    const options = monacoWorkspaceSettingsToEditorOptions({
      ...defaultMonacoWorkspaceEditorSettings(),
      lineNumbers: 'off',
      folding: false,
    });
    expect(options.lineNumbers).toBe('off');
    expect(options.folding).toBe(false);
  });
});
