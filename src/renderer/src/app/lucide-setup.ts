import { EnvironmentProviders, importProvidersFrom, Provider } from '@angular/core';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSearch,
  FileText,
  Folder,
  FolderPlus,
  List,
  LucideAngularModule,
  LucideIconConfig,
  Maximize,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Minus,
  Pin,
  Plus,
  Scan,
  Search,
  Settings,
  Square,
  Trash,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
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
      ChevronLeft,
      ChevronRight,
      Copy,
      FileSearch,
      FileText,
      Folder,
      FolderPlus,
      List,
      Maximize,
      Maximize2,
      MessageSquare,
      Mic,
      Minimize2,
      Minus,
      Pin,
      Plus,
      Scan,
      Search,
      Settings,
      Square,
      Trash,
      TriangleAlert,
      X,
      ZoomIn,
      ZoomOut,
    }),
  ),
];
