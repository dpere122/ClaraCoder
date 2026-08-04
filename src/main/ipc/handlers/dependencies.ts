import { ipcMain } from 'electron';
import { defaultDependencyCatalog, type DependencyId } from '../../../shared';
import {
  deleteDependency,
  installDependency,
  isKnownDependencyId,
  listDependencies,
  reinstallDependency,
} from '../../runtime/dependency-manager';
import { closeDependenciesWindow, createDependenciesWindow } from '../../windows/dependencies-window';

export function registerDependenciesIpc(): void {
  ipcMain.handle('deps:list', async () => {
    try {
      const result = await listDependencies();
      return { ok: true as const, dependencies: result.dependencies, warning: result.error };
    } catch (err) {
      return {
        ok: true as const,
        dependencies: defaultDependencyCatalog(),
        warning: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('deps:install', async (_e, depId: string) => {
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return installDependency(depId as DependencyId);
  });

  ipcMain.handle('deps:reinstall', async (_e, depId: string) => {
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return reinstallDependency(depId as DependencyId);
  });

  ipcMain.handle('deps:delete', async (_e, depId: string) => {
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return deleteDependency(depId as DependencyId);
  });

  ipcMain.on('open-dependencies-window', () => {
    createDependenciesWindow();
  });
  ipcMain.on('close-dependencies-window', () => {
    closeDependenciesWindow();
  });
}
