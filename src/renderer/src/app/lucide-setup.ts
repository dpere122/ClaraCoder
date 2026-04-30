import { EnvironmentProviders, importProvidersFrom, Provider } from '@angular/core';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  LucideAngularModule,
  LucideIconConfig,
  Minus,
  Plus,
  Settings,
  Square,
  Trash,
  X,
} from 'lucide-angular';

export function lucideIconConfigFactory(): LucideIconConfig {
  const cfg = new LucideIconConfig();
  cfg.color = 'currentColor';
  return cfg;
}

/** Icons used in templates; keep in sync when adding `<lucide-icon>`. */
export const lucideAppProviders: Array<Provider | EnvironmentProviders> = [
  { provide: LucideIconConfig, useFactory: lucideIconConfigFactory },
  importProvidersFrom(
    LucideAngularModule.pick({
      ChevronDown,
      ChevronRight,
      Copy,
      FileText,
      Folder,
      FolderPlus,
      Minus,
      Plus,
      Settings,
      Square,
      Trash,
      X,
    }),
  ),
];
