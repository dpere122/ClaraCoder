import type * as Monaco from 'monaco-editor';
import type { MonacoWorkspaceEditorSettings } from '@shared/index';

/** Used when fontFamily is left blank; follows `--t-font-mono`, which themes override with different stacks. */
const DEFAULT_MONO_FONT = "var(--t-font-mono, 'JetBrains Mono', 'Cascadia Code', Consolas, monospace)";

function fontSpecUsesCssVariables(spec: string): boolean {
  return /\bvar\s*\(/i.test(spec.trim());
}

/**
 * Monaco measures glyph widths using the `fontFamily` string it is given. If we pass `var(--t-font-mono, …)`,
 * the string never changes when the shell theme switches, even though the **resolved** font (Georgia vs Cascadia, etc.)
 * does — hit-testing and selection then drift. Resolve theme vars to the browser's computed family before handing off.
 *
 * The Settings → General "Code font" picker sets `--t-font-code-override` and always takes priority over this
 * per-editor `fontFamily` setting when present (it "overrides the Monaco editor font option", per design).
 */
export function resolveMonacoWorkspaceFontFamily(s: MonacoWorkspaceEditorSettings): string {
  const perEditor = s.fontFamily.trim() ? s.fontFamily.trim() : DEFAULT_MONO_FONT;
  const raw = `var(--t-font-code-override, ${perEditor})`;
  if (typeof document === 'undefined' || !fontSpecUsesCssVariables(raw)) {
    return raw;
  }
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  const fs = Number.isFinite(s.fontSize) && s.fontSize > 0 ? s.fontSize : 13;
  const lh = s.lineHeight > 0 ? `${s.lineHeight}px` : 'normal';
  probe.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:pre',
    `font-size:${fs}px`,
    `line-height:${lh}`,
  ].join(';');
  probe.style.fontFamily = raw;
  document.documentElement.appendChild(probe);
  try {
    const resolved = getComputedStyle(probe).fontFamily.trim();
    return resolved.length > 0 ? resolved : raw;
  } finally {
    probe.remove();
  }
}

/** Maps persisted settings to Monaco `IEditorOptions` (theme and `automaticLayout` are applied separately). */
export function monacoWorkspaceSettingsToEditorOptions(
  s: MonacoWorkspaceEditorSettings,
): Monaco.editor.IEditorOptions {
  return {
    // Hovers / suggest / peek render above cursor; `overflow: hidden` on workspace host
    // clips them unless widgets use fixed positioning (VS Code–style, viewport-relative flip).
    fixedOverflowWidgets: true,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight <= 0 ? undefined : s.lineHeight,
    fontFamily: resolveMonacoWorkspaceFontFamily(s),
    wordWrap: s.wordWrap,
    wordWrapColumn: s.wordWrapColumn,
    minimap: {
      enabled: s.minimapEnabled,
      maxColumn: s.minimapMaxColumn,
      renderCharacters: s.minimapRenderCharacters,
      showSlider: s.minimapShowSlider,
    },
    scrollBeyondLastLine: s.scrollBeyondLastLine,
    smoothScrolling: s.smoothScrolling,
    renderWhitespace: s.renderWhitespace,
    renderLineHighlight: s.renderLineHighlight,
    renderControlCharacters: s.renderControlCharacters,
    lineNumbers: s.lineNumbers,
    glyphMargin: s.glyphMargin,
    folding: s.folding,
    guides: {
      indentation: s.guidesIndentation,
      bracketPairs: s.guidesBracketPairs,
    },
    bracketPairColorization: {
      enabled: s.bracketPairColorizationEnabled,
    },
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    detectIndentation: s.detectIndentation,
    cursorBlinking: s.cursorBlinking,
    cursorStyle: s.cursorStyle,
    cursorWidth: s.cursorWidth <= 0 ? undefined : s.cursorWidth,
    formatOnPaste: s.formatOnPaste,
    formatOnType: s.formatOnType,
    quickSuggestions: s.quickSuggestions,
    autoClosingBrackets: s.autoClosingBrackets,
    autoClosingQuotes: s.autoClosingQuotes,
    acceptSuggestionOnEnter: s.acceptSuggestionOnEnter,
    padding: { top: s.paddingTop, bottom: s.paddingBottom },
  } as Monaco.editor.IEditorOptions;
}
