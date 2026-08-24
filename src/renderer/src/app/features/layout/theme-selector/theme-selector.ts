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
