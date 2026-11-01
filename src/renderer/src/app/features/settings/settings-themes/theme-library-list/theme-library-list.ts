import { Component, ViewEncapsulation, inject } from '@angular/core';
import { builtInThemeForMode, type ClaraThemeDocument } from '@shared/theme';
import { SettingsThemesStore } from '../settings-themes-store';

const SWATCH_TOKENS = ['--t-bg', '--t-bg-surface', '--t-primary', '--t-secondary', '--t-fg', '--t-confirm'];

/** Scrollable list of built-in and user themes with pick / create / duplicate / delete / import / export. */
@Component({
  selector: 'app-theme-library-list',
  templateUrl: './theme-library-list.html',
  encapsulation: ViewEncapsulation.None,
})
export class ThemeLibraryList {
  protected readonly s = inject(SettingsThemesStore);

  protected swatches(theme: ClaraThemeDocument): string[] {
    const base = builtInThemeForMode(theme.mode).tokens;
    return SWATCH_TOKENS.map((name) => theme.tokens[name] ?? base[name] ?? 'transparent');
  }

  protected isSelected(theme: ClaraThemeDocument): boolean {
    return this.s.selectedId() === theme.id;
  }
}
