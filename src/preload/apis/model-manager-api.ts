import { ipcRenderer } from 'electron';

/** Local model manager (HF search, rename, delete). */
export const modelManagerApi = {
  modelManagerPickCustomDir: () => ipcRenderer.invoke('model-manager:pick-custom-dir'),
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
  modelManagerListHfFiles: (payload: { id: string; token?: string }) =>
    ipcRenderer.invoke('model-manager:list-hf-files', payload),
};
