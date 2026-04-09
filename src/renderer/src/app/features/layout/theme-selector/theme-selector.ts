import { Component, OnInit, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
  { id: 'steampunk', label: 'Steam Punk', cssClass: 'theme-steampunk', bsTheme: 'dark' },
  { id: 'win95', label: 'Windows 95', cssClass: 'theme-win95', bsTheme: 'light' },
  { id: 'woodland', label: 'Woodland', cssClass: 'theme-woodland', bsTheme: 'dark' },
  { id: 'ion', label: 'Ion', cssClass: 'theme-ion', bsTheme: 'dark' },
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
  protected readonly themeLabel = signal('Workspace Theme');

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electron.loadConfig();
    this.syncFromConfig(config);

    this.electron.config$.subscribe((nextConfig) => {
      this.syncFromConfig(nextConfig);
    });
  }

  async onThemeChange(id: string): Promise<void> {
    const workspace = await this.electron.getCurrentWorkspace();
    this.themeId.set(id);
    this.applyTheme(id);

    if (workspace) {
      await this.electron.setWorkspaceTheme(workspace.id, id);
      return;
    }

    await this.electron.setNoWorkspaceTheme(id);
  }

  private syncFromConfig(config: AppConfig): void {
    const workspace = config.currentWorkspaceId
      ? config.workspaces.find((item) => item.id === config.currentWorkspaceId) ?? null
      : null;
    const themeToApply = workspace?.themeId || config.noWorkspaceThemeId || 'dark';
    this.themeLabel.set(workspace ? 'Workspace Theme' : 'No-Workspace Theme');
    this.themeId.set(themeToApply);
    this.applyTheme(themeToApply);
  }

  private applyTheme(themeId: string): void {
    const theme = THEMES.find((t) => t.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }
}
