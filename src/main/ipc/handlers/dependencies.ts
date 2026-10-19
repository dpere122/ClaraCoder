import { promises as fs } from 'fs';
import { ipcMain, shell } from 'electron';
import { defaultDependencyCatalog, type DependencyId } from '../../../shared';
import {
  cancelDependencyInstall,
  deleteDependency,
  installDependency,
  isKnownDependencyId,
  listDependencies,
  reinstallDependency,
} from '../../runtime/dependency-manager';
import { closeDependenciesWindow, createDependenciesWindow } from '../../windows/dependencies-window';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

export function registerDependenciesIpc(): void {
  ipcMain.handle('deps:list', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender', dependencies: defaultDependencyCatalog() };
    }
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

  ipcMain.handle('deps:install', async (event, depId: string, variant?: string | null) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return installDependency(depId as DependencyId, variant ?? null);
  });

  ipcMain.handle('deps:reinstall', async (event, depId: string, variant?: string | null) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return reinstallDependency(depId as DependencyId, variant ?? null);
  });

  ipcMain.handle('deps:delete', async (event, depId: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return deleteDependency(depId as DependencyId);
  });

  ipcMain.handle('deps:cancel', async (event, depId: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    return cancelDependencyInstall(depId as DependencyId);
  });

  // Renderer passes only an id; the path comes from the dependency's own status report.
  ipcMain.handle('deps:reveal', async (event, depId: string) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (!isKnownDependencyId(depId)) {
      return { ok: false as const, error: `Unknown dependency: ${depId}` };
    }
    try {
      const { dependencies } = await listDependencies();
      const target = dependencies.find((d) => d.id === depId)?.path;
      if (!target) {
        return { ok: false as const, error: 'Not installed' };
      }
      await fs.stat(target);
      shell.showItemInFolder(target);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on('open-dependencies-window', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    createDependenciesWindow();
  });
  ipcMain.on('close-dependencies-window', (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return;
    }
    closeDependenciesWindow();
  });
}
