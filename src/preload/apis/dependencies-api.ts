import type { PreloadIpc } from '../preload-ipc';
import type { DependencyActionResult, DependencyId, DependencyInfo, DependencyProgressEvent } from '../../shared';

export const createDependenciesApi = (ipcRenderer: PreloadIpc) => ({
  depsList: () =>
    ipcRenderer.invoke('deps:list') as Promise<{
      ok: boolean;
      dependencies: DependencyInfo[];
      error?: string;
      warning?: string;
    }>,
  depsInstall: (depId: DependencyId, variant?: string | null) =>
    ipcRenderer.invoke('deps:install', depId, variant ?? null) as Promise<DependencyActionResult>,
  depsReinstall: (depId: DependencyId, variant?: string | null) =>
    ipcRenderer.invoke('deps:reinstall', depId, variant ?? null) as Promise<DependencyActionResult>,
  depsDelete: (depId: DependencyId) =>
    ipcRenderer.invoke('deps:delete', depId) as Promise<DependencyActionResult>,
  openDependenciesWindow: () => ipcRenderer.send('open-dependencies-window'),
  closeDependenciesWindow: () => ipcRenderer.send('close-dependencies-window'),
  onDepsProgress: (callback: (event: unknown, data: DependencyProgressEvent) => void) =>
    ipcRenderer.on('deps:progress', callback),
  offDepsProgress: (callback: (event: unknown, data: DependencyProgressEvent) => void) =>
    ipcRenderer.removeListener('deps:progress', callback),
});
