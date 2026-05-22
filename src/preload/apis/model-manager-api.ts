import { ipcRenderer } from 'electron';
import type { ModelManagerMigrateProgressPayload } from '../../shared';

/** Local model manager (HF search, migrate, rename, delete). */
export const modelManagerApi = {
  modelManagerPickCustomDir: () => ipcRenderer.invoke('model-manager:pick-custom-dir'),
  modelManagerListCustomModels: (payload: { customDir: string }) =>
    ipcRenderer.invoke('model-manager:list-custom-models', payload),
  modelManagerDetectCaches: () => ipcRenderer.invoke('model-manager:detect-caches'),
  modelManagerListCacheCandidates: (payload: { cachePaths: string[] }) =>
    ipcRenderer.invoke('model-manager:list-cache-candidates', payload),
  modelManagerChooseMigrateMode: (payload: { title?: string; detail?: string }) =>
    ipcRenderer.invoke('model-manager:choose-migrate-mode', payload),
  modelManagerSubscribeMigrateProgress: (callback: (payload: ModelManagerMigrateProgressPayload) => void) => {
    const channel = 'model-manager:migrate-progress';
    const listener = (_event: unknown, payload: ModelManagerMigrateProgressPayload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  modelManagerMigrateModel: (payload: {
    sourcePath: string;
    customDir: string;
    mode: 'copy' | 'move';
    suggestedFileName?: string;
    entryKind?: 'file' | 'hubRepo';
  }) => ipcRenderer.invoke('model-manager:migrate-model', payload),
  modelManagerRenameModel: (payload: {
    customDir: string;
    modelPath: string;
    newFileName: string;
  }) => ipcRenderer.invoke('model-manager:rename-model', payload),
  modelManagerDeleteModel: (payload: { customDir: string; modelPath: string }) =>
    ipcRenderer.invoke('model-manager:delete-model', payload),
  modelManagerSearchHf: (payload: { query: string; token?: string; limit?: number }) =>
    ipcRenderer.invoke('model-manager:search-hf', payload),
};
