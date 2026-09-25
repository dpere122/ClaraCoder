import { Component, ViewEncapsulation, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  THEME_BACKGROUND_FITS,
  themeTokenDef,
  type ThemeBackgroundFit,
  type ThemeGroupBackground,
  type ThemeGroupDef,
  type ThemeGroupOverride,
  type ThemeTokenDef,
} from '@shared/theme';
import { rendererThemeAssetUrl } from '../../../../core/theme/theme-dom';
import { ThemeTokenEditor, type ThemeTokenChange } from '../theme-token-editor/theme-token-editor';

/**
 * One registered element group: scoped token overrides, advanced CSS, and (when the group
 * opts in) a background image overlay with enable toggle, opacity slider, and fit.
 */
@Component({
  selector: 'app-theme-group-panel',
  imports: [FormsModule, ThemeTokenEditor],
  templateUrl: './theme-group-panel.html',
  encapsulation: ViewEncapsulation.None,
})
export class ThemeGroupPanel {
  readonly group = input.required<ThemeGroupDef>();
  readonly override = input<ThemeGroupOverride | undefined>(undefined);
  readonly themeId = input.required<string>();
  readonly assets = input<Record<string, string>>({});
  /** Effective global tokens (what the group inherits). */
  readonly inherited = input.required<Record<string, string>>();
  readonly readOnly = input(false);
  readonly cssWarnings = input<string[]>([]);

  readonly tokenChange = output<ThemeTokenChange>();
  readonly cssChange = output<string>();
  readonly backgroundChange = output<Partial<ThemeGroupBackground>>();
  readonly backgroundClear = output<void>();
  readonly pickAsset = output<void>();
  readonly removeAsset = output<string>();

  protected readonly fits = THEME_BACKGROUND_FITS;
  protected readonly expanded = signal<boolean | null>(null);

  protected readonly tokenDefs = computed<ThemeTokenDef[]>(() =>
    this.group()
      .tokens.map((name) => themeTokenDef(name))
      .filter((def): def is ThemeTokenDef => def !== undefined),
  );

  protected readonly customized = computed(() => {
    const o = this.override();
    return !!o && (!!o.tokens || !!o.css || !!o.background);
  });

  protected readonly isOpen = computed(() => this.expanded() ?? this.customized());

  protected readonly background = computed<ThemeGroupBackground>(
    () => this.override()?.background ?? { enabled: false, asset: '', opacity: 0.35, fit: 'cover' },
  );

  protected readonly assetKeys = computed(() => Object.keys(this.assets()).sort());

  protected readonly previewUrl = computed(() => {
    const bg = this.background();
    const value = this.assets()[bg.asset];
    return value ? rendererThemeAssetUrl(this.themeId(), bg.asset, value) : null;
  });

  protected readonly opacityPercent = computed(() => Math.round(this.background().opacity * 100));

  protected toggle(): void {
    this.expanded.set(!this.isOpen());
  }

  protected onCss(css: string): void {
    if (!this.readOnly()) {
      this.cssChange.emit(css);
    }
  }

  protected onEnabled(enabled: boolean): void {
    if (!this.readOnly()) {
      this.backgroundChange.emit({ enabled });
    }
  }

  protected onOpacity(percent: string | number): void {
    if (this.readOnly()) {
      return;
    }
    const n = typeof percent === 'number' ? percent : parseFloat(percent);
    if (Number.isFinite(n)) {
      this.backgroundChange.emit({ opacity: Math.min(100, Math.max(0, n)) / 100 });
    }
  }

  protected onFit(fit: string): void {
    if (!this.readOnly() && THEME_BACKGROUND_FITS.indexOf(fit as ThemeBackgroundFit) >= 0) {
      this.backgroundChange.emit({ fit: fit as ThemeBackgroundFit });
    }
  }

  protected onAsset(asset: string): void {
    if (!this.readOnly()) {
      this.backgroundChange.emit({ asset, enabled: !!asset });
    }
  }
}
