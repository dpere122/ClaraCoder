import type { PreloadIpc } from '../preload-ipc';
import type { HfDownloadId, HfDownloadProgressEvent } from '../../shared';

/** Local model manager (HF search, rename, delete, GGUF download). */
export const createModelManagerApi = (ipcRenderer: PreloadIpc) => ({
  modelManagerPickCustomDir: () => ipcRenderer.invoke('model-manager:pick-custom-dir'),
  modelManagerSecretStorage: () => ipcRenderer.invoke('model-manager:secret-storage'),
  modelManagerListCustomModels: (payload: { customDir: string }) =>
    ipcRenderer.invoke('model-manager:list-custom-models', payload),
  modelManagerRenameModel: (payload: {
    customDir: string;
    modelPath: string;
    newFileName: string;
  }) => ipcRenderer.invoke('model-manager:rename-model', payload),
  modelManagerDeleteModel: (payload: { customDir: string; modelPath: string }) =>
    ipcRenderer.invoke('model-manager:delete-model', payload),
  modelManagerSearchHf: (payload: { query: string; token?: string; limit?: number; skip?: number; fileType?: string }) =>
    ipcRenderer.invoke('model-manager:search-hf', payload),
  modelManagerHfModelDetails: (payload: { id: string; token?: string }) =>
    ipcRenderer.invoke('model-manager:hf-model-details', payload),
  modelManagerListHfFiles: (payload: { id: string; token?: string }) =>
    ipcRenderer.invoke('model-manager:list-hf-files', payload),
  modelManagerDownloadHfFile: (payload: { repoId: string; fileName: string; customDir: string; token?: string }) =>
    ipcRenderer.invoke('model-manager:download-hf-file', payload),
  modelManagerCancelHfDownload: (payload: { downloadId: HfDownloadId }) =>
    ipcRenderer.invoke('model-manager:cancel-hf-download', payload),
  onModelManagerHfDownloadProgress: (callback: (event: unknown, data: HfDownloadProgressEvent) => void) =>
    ipcRenderer.on('model-manager:hf-download-progress', callback),
});
