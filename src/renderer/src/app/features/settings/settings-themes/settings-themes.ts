import { Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  THEME_TOKEN_CATEGORIES,
  themeTokensInCategory,
  type ThemeGroupDef,
  type ThemeGroupOverride,
  type ThemeTokenCategoryId,
  type ThemeTokenDef,
} from '@shared/theme';
import { SettingsStore } from '../settings/settings-store';
import { themesCategoryFromSubTabId } from '../settings/settings-tabs';
import { SettingsThemesStore } from './settings-themes-store';
import { ThemeGroupPanel } from './theme-group-panel/theme-group-panel';
import { ThemeLibraryList } from './theme-library-list/theme-library-list';
import { ThemeMonacoPanel } from './theme-monaco-panel/theme-monaco-panel';
import { ThemeTokenEditor, type ThemeTokenChange } from './theme-token-editor/theme-token-editor';

interface TokenCategoryView {
  id: ThemeTokenCategoryId;
  label: string;
  description: string;
  tokens: ThemeTokenDef[];
}

/**
 * Settings → Themes pane. Sub-tabs come from `buildThemesSubTabs()`: the library, global
 * tokens, one pane per registry category (generated), the editor palette, and Advanced.
 */
@Component({
  selector: 'app-settings-themes',
  imports: [FormsModule, ThemeLibraryList, ThemeTokenEditor, ThemeGroupPanel, ThemeMonacoPanel],
  templateUrl: './settings-themes.html',
  styleUrl: './settings-themes.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsThemes {
  protected readonly s = inject(SettingsStore);
  protected readonly t = inject(SettingsThemesStore);

  protected readonly subTab = computed(() => this.s.activeSubTabId('themes'));
  protected readonly category = computed(() => themesCategoryFromSubTabId(this.subTab()));

  protected readonly tokenCategories: readonly TokenCategoryView[] = THEME_TOKEN_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    tokens: themeTokensInCategory(c.id),
  }));

  protected readonly categoryGroups = computed<ThemeGroupDef[]>(() => {
    const category = this.category();
    return category ? this.t.groups.filter((g) => g.category === category) : [];
  });

  protected readonly categoryLabel = computed(() => this.categoryGroups()[0]?.categoryLabel ?? '');

  /** Advanced pane: JSON scratch buffer (loaded from the draft on demand). */
  protected readonly jsonText = signal('');
  protected readonly jsonMessage = signal('');

  protected override(groupId: string): ThemeGroupOverride | undefined {
    return this.t.selectedTheme().groups[groupId];
  }

  protected cssWarnings(groupId: string): string[] {
    return this.t.groupCssWarnings(groupId, this.override(groupId)?.css ?? '');
  }

  protected onGlobalToken(change: ThemeTokenChange): void {
    this.t.setToken(change.name, change.value);
  }

  protected onGroupToken(groupId: string, change: ThemeTokenChange): void {
    this.t.setGroupToken(groupId, change.name, change.value);
  }

  protected loadJson(): void {
    this.jsonText.set(JSON.stringify(this.t.selectedTheme(), null, 2));
    this.jsonMessage.set('');
  }

  protected applyJson(): void {
    const result = this.t.applyJson(this.jsonText());
    if ('error' in result && result.error) {
      this.jsonMessage.set(result.error);
      return;
    }
    if (!result.ok) {
      const errors = 'errors' in result ? result.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : '';
      this.jsonMessage.set(errors ? `Rejected — ${errors}` : 'Rejected.');
      return;
    }
    const warnings = 'warnings' in result ? result.warnings.length : 0;
    this.jsonMessage.set(warnings > 0 ? `Applied with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Applied.');
  }
}
