import { Component, ViewEncapsulation, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  THEME_MONACO_BASES,
  deriveMonacoTheme,
  normalizeMonacoHex,
  type ThemeMonacoBase,
  type ThemeMonacoDefinition,
} from '@shared/theme';
import { createDomColorResolver } from '../../../../core/theme/theme-dom';
import { SettingsThemesStore } from '../settings-themes-store';

interface MonacoColorRow {
  key: string;
  label: string;
}

interface MonacoRuleRow {
  scope: string;
  label: string;
}

export const MONACO_PANEL_COLORS: readonly MonacoColorRow[] = [
  { key: 'editor.background', label: 'Editor background' },
  { key: 'editor.foreground', label: 'Editor text' },
  { key: 'editorLineNumber.foreground', label: 'Line numbers' },
  { key: 'editorLineNumber.activeForeground', label: 'Active line number' },
  { key: 'editorCursor.foreground', label: 'Cursor' },
  { key: 'editor.selectionBackground', label: 'Selection' },
  { key: 'editor.lineHighlightBackground', label: 'Current line' },
  { key: 'editorIndentGuide.background1', label: 'Indent guides' },
  { key: 'editorWidget.background', label: 'Widgets (find, suggest)' },
  { key: 'editorWidget.border', label: 'Widget border' },
  { key: 'scrollbarSlider.background', label: 'Scrollbar' },
  { key: 'editorBracketMatch.border', label: 'Bracket match' },
];

export const MONACO_PANEL_RULES: readonly MonacoRuleRow[] = [
  { scope: '', label: 'Default text' },
  { scope: 'comment', label: 'Comments' },
  { scope: 'keyword', label: 'Keywords' },
  { scope: 'string', label: 'Strings' },
  { scope: 'number', label: 'Numbers' },
  { scope: 'type', label: 'Types' },
  { scope: 'function', label: 'Functions' },
  { scope: 'variable', label: 'Variables' },
  { scope: 'constant', label: 'Constants' },
  { scope: 'delimiter', label: 'Punctuation' },
  { scope: 'operator', label: 'Operators' },
  { scope: 'tag', label: 'Tags' },
  { scope: 'attribute.name', label: 'Attributes' },
  { scope: 'metatag', label: 'Meta' },
];

/**
 * Editor palette pane. By default the Monaco theme is derived from the app tokens; "Customize"
 * snapshots that derivation into the document so individual colors and syntax rules can be edited.
 */
@Component({
  selector: 'app-theme-monaco-panel',
  imports: [FormsModule],
  templateUrl: './theme-monaco-panel.html',
  encapsulation: ViewEncapsulation.None,
})
export class ThemeMonacoPanel {
  protected readonly s = inject(SettingsThemesStore);
  protected readonly bases = THEME_MONACO_BASES;
  protected readonly colorRows = MONACO_PANEL_COLORS;
  protected readonly ruleRows = MONACO_PANEL_RULES;

  private readonly resolver = createDomColorResolver(document);

  protected readonly customized = computed(() => !!this.s.selectedTheme().monaco);

  /** Palette that would apply right now (custom block, else derived from tokens). */
  protected readonly current = computed<ThemeMonacoDefinition>(() =>
    deriveMonacoTheme(this.s.selectedTheme(), { baseTokens: this.s.effectiveTokens(), resolver: this.resolver }),
  );

  protected color(key: string): string {
    return this.current().colors[key] ?? '';
  }

  protected colorPicker(key: string): string {
    const v = this.color(key);
    return v ? v.slice(0, 7) : '#000000';
  }

  protected rule(scope: string): string {
    const r = this.current().rules.find((x) => x.token === scope);
    return r?.foreground ? `#${r.foreground}` : '';
  }

  protected rulePicker(scope: string): string {
    const v = this.rule(scope);
    return v ? v.slice(0, 7) : '#000000';
  }

  protected ruleStyle(scope: string): string {
    const r = this.current().rules.find((x) => x.token === scope);
    return r?.fontStyle ?? '';
  }

  protected customize(): void {
    if (this.s.readOnly()) {
      return;
    }
    const snapshot = this.current();
    this.s.setMonaco({
      base: snapshot.base,
      colors: { ...snapshot.colors },
      rules: snapshot.rules.map((r) => ({ ...r })),
    });
  }

  protected revert(): void {
    if (!this.s.readOnly()) {
      this.s.setMonaco(null);
    }
  }

  private mutate(mutator: (def: ThemeMonacoDefinition) => void): void {
    if (this.s.readOnly()) {
      return;
    }
    const base = this.s.selectedTheme().monaco ?? this.current();
    const next: ThemeMonacoDefinition = {
      base: base.base,
      colors: { ...base.colors },
      rules: base.rules.map((r) => ({ ...r })),
    };
    mutator(next);
    this.s.setMonaco(next);
  }

  protected setBase(base: string): void {
    if (THEME_MONACO_BASES.indexOf(base as ThemeMonacoBase) >= 0) {
      this.mutate((def) => {
        def.base = base as ThemeMonacoBase;
      });
    }
  }

  protected setColor(key: string, value: string): void {
    const hex = normalizeMonacoHex(value);
    this.mutate((def) => {
      if (hex) {
        def.colors[key] = hex;
      } else {
        delete def.colors[key];
      }
    });
  }

  protected setRuleColor(scope: string, value: string): void {
    const hex = normalizeMonacoHex(value);
    this.mutate((def) => {
      const existing = def.rules.find((r) => r.token === scope);
      if (!hex) {
        def.rules = def.rules.filter((r) => r.token !== scope);
        return;
      }
      if (existing) {
        existing.foreground = hex.slice(1, 7);
      } else {
        def.rules.push({ token: scope, foreground: hex.slice(1, 7) });
      }
    });
  }

  protected setRuleStyle(scope: string, fontStyle: string): void {
    this.mutate((def) => {
      const existing = def.rules.find((r) => r.token === scope);
      if (!existing) {
        if (fontStyle) {
          def.rules.push({ token: scope, fontStyle });
        }
        return;
      }
      if (fontStyle) {
        existing.fontStyle = fontStyle;
      } else {
        delete existing.fontStyle;
      }
    });
  }
}
