import { ipcMain } from 'electron';
import {
  coerceLmStudioContextTokens,
  type LmStudioListModelsResult,
  type LmStudioLoadOptions,
  type LmStudioMutationResult,
} from '../../../shared/lm-studio-ipc';
import { lmStudioListModels, lmStudioLoadModel, lmStudioUnloadModel } from '../../lm-studio-client';
import { lmStudioOpenAiBaseUrlToRestOrigin } from '../../../shared/lm-studio-url';

function loadOptionsFromIpc(raw: LmStudioLoadOptions | undefined): LmStudioLoadOptions {
  const contextLength = coerceLmStudioContextTokens(raw?.contextLength);
  const parallel = coerceLmStudioContextTokens(raw?.parallel);
  const evalBatchSize = coerceLmStudioContextTokens(raw?.evalBatchSize);
  return {
    ...(contextLength ? { contextLength } : {}),
    ...(parallel ? { parallel } : {}),
    ...(evalBatchSize ? { evalBatchSize } : {}),
    ...(typeof raw?.flashAttention === 'boolean' ? { flashAttention: raw.flashAttention } : {}),
    ...(typeof raw?.offloadKvCacheToGpu === 'boolean' ? { offloadKvCacheToGpu: raw.offloadKvCacheToGpu } : {}),
  };
}

export function registerLmStudioIpc(): void {
  ipcMain.handle(
    'lm-studio:list-models',
    async (_event, payload: { baseUrl: string; apiKey?: string }): Promise<LmStudioListModelsResult> => {
      const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
      return lmStudioListModels(baseUrl, apiKey);
    },
  );

  ipcMain.handle(
    'lm-studio:load-model',
    async (
      _event,
      payload: { baseUrl: string; model: string; apiKey?: string; options?: LmStudioLoadOptions },
    ): Promise<LmStudioMutationResult> => {
      const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
      const model = typeof payload?.model === 'string' ? payload.model : '';
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
      const origin = lmStudioOpenAiBaseUrlToRestOrigin(baseUrl);
      if (!origin) {
        return { ok: false, error: 'Invalid base URL' };
      }
      if (!model.trim()) {
        return { ok: false, error: 'Missing model id' };
      }
      const r = await lmStudioLoadModel(origin, model.trim(), apiKey, loadOptionsFromIpc(payload?.options));
      return r;
    },
  );

  ipcMain.handle(
    'lm-studio:unload-model',
    async (
      _event,
      payload: { baseUrl: string; instanceId: string; apiKey?: string },
    ): Promise<LmStudioMutationResult> => {
      const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl : '';
      const instanceId = typeof payload?.instanceId === 'string' ? payload.instanceId : '';
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey : '';
      const origin = lmStudioOpenAiBaseUrlToRestOrigin(baseUrl);
      if (!origin) {
        return { ok: false, error: 'Invalid base URL' };
      }
      if (!instanceId.trim()) {
        return { ok: false, error: 'Missing instance id' };
      }
      return lmStudioUnloadModel(origin, instanceId.trim(), apiKey);
    },
  );
}
