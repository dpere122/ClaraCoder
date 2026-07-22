import { Component, DestroyRef, OnInit, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AppConfig } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

export interface ThemeOption {
  id: string;
  label: string;
  cssClass: string;
  bsTheme: 'dark' | 'light';
}

export const THEMES: ThemeOption[] = [
  { id: 'woodland', label: 'Woodland', cssClass: 'theme-woodland', bsTheme: 'dark' },
  { id: 'classical', label: 'Classical', cssClass: 'theme-classical', bsTheme: 'light' },
  { id: 'dark-classical', label: 'Dark Classical', cssClass: 'theme-dark-classical', bsTheme: 'dark' },
];

export const APP_THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME_ID = 'woodland';

@Component({
  selector: 'app-theme-selector',
  imports: [FormsModule],
  templateUrl: './theme-selector.html',
  styleUrl: './theme-selector.css',
  encapsulation: ViewEncapsulation.None
})
export class ThemeSelector implements OnInit {
  readonly themeId = signal(THEMES[0].id);
  protected readonly themes = THEMES;

  constructor(
    private electron: ElectronService,
    private destroyRef: DestroyRef,
  ) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electron.loadConfig();
    this.syncFromConfig(config);

    this.electron.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((nextConfig: AppConfig) => {
      this.syncFromConfig(nextConfig);
    });
  }

  async onThemeChange(id: string): Promise<void> {
    this.themeId.set(id);
    this.applyTheme(id);
    await this.electron.setTheme(id);
  }

  private syncFromConfig(config: AppConfig): void {
    const themeToApply = config.themeId || DEFAULT_THEME_ID;
    this.themeId.set(themeToApply);
    this.applyTheme(themeToApply);
  }

  private applyTheme(themeId: string): void {
    const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
    document.documentElement.className = theme.cssClass;
    document.documentElement.setAttribute('data-bs-theme', theme.bsTheme);
  }
}
