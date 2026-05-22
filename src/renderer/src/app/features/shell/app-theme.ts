import type { AppConfig } from '@shared/index';
import { THEMES } from '../layout/theme-selector/theme-selector';

/** Resolve theme id: workspace override > no-workspace default > dark. */
export function resolveAppThemeId(config: AppConfig, workspaceId?: string | null): string {
  let themeToApply = config.noWorkspaceThemeId || 'dark';
  const wsId = workspaceId ?? config.currentWorkspaceId;
  if (wsId) {
    const workspace = config.workspaces.find((w) => w.id === wsId);
    if (workspace?.themeId) {
      themeToApply = workspace.themeId;
    }
  }
  return themeToApply;
}

export function applyAppTheme(themeId: string): void {
  const theme = THEMES.find((t) => t.id === themeId);
  document.documentElement.className = theme?.cssClass ?? '';
  document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
}
