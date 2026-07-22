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
  { id: 'dark', label: 'Dark', cssClass: '', bsTheme: 'dark' },
  { id: 'pink', label: 'Pink', cssClass: 'theme-pink', bsTheme: 'dark' },
  { id: 'classical', label: 'Classical', cssClass: 'theme-classical', bsTheme: 'light' },
  { id: 'dark-classical', label: 'Dark Classical', cssClass: 'theme-dark-classical', bsTheme: 'dark' },
  { id: 'win95', label: 'Windows 95', cssClass: 'theme-win95', bsTheme: 'light' },
  { id: 'woodland', label: 'Woodland', cssClass: 'theme-woodland', bsTheme: 'dark' },
  { id: 'ion', label: 'Ion', cssClass: 'theme-ion', bsTheme: 'dark' },
  { id: 'purple-girl', label: 'Purple Girl', cssClass: 'theme-purple-girl', bsTheme: 'dark' },
  {
    id: 'ps2',
    label: 'PS2',
    cssClass: 'theme-ps2',
    bsTheme: 'dark',
  },
  {
    id: 'halo3',
    label: 'Halo 3',
    cssClass: 'theme-halo3',
    bsTheme: 'dark',
  },
  {
    id: 'phantom-hourglass',
    label: 'Phantom Hourglass',
    cssClass: 'theme-phantom-hourglass',
    bsTheme: 'light',
  },
  {
    id: 'kawaii-bow',
    label: 'Kawaii Bow',
    cssClass: 'theme-kawaii-bow',
    bsTheme: 'light',
  },
  {
    id: 'visual-studio',
    label: 'Visual Studio',
    cssClass: 'theme-visual-studio',
    bsTheme: 'light',
  },
];

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
    const themeToApply = config.themeId || 'dark';
    this.themeId.set(themeToApply);
    this.applyTheme(themeToApply);
  }

  private applyTheme(themeId: string): void {
    const theme = THEMES.find((t) => t.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }
}
