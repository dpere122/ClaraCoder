/**
 * Claude source: API key (write-only from the renderer's side), status, and model pick.
 * Renderers never receive the key; they get {@link AnthropicStatus} with a short hint instead.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import type {
  AnthropicCatalogModel,
  AnthropicListModelsResult,
  AnthropicSetKeyResult,
  AnthropicSetModelResult,
  AppConfig,
} from '../../../shared';
import { PINNED_ANTHROPIC_PROVIDER_ID, inferContextWindowTokens } from '../../../shared';
import { clearAnthropicApiKey, setAnthropicApiKey } from '../../anthropic-key-store';
import {
  describeAnthropicError,
  findAnthropicModel,
  getAnthropicStatus,
  isAnthropicAuthError,
  listAnthropicModels,
  resetAnthropicCatalog,
} from '../../anthropic-models';
import { updateConfig } from '../../config/load-save';
import { getLlamaManagedRuntimeOverrides } from '../../llama-server-manager';
import { syncRuntimeConfigToPython } from '../../python/workspace-sync';
import { mainState } from '../../state';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

/** Picked when a key is first saved and no model is set yet. */
const DEFAULT_CLAUDE_MODEL_ID = 'claude-opus-5-5';
/** Anthropic keys are ~100 chars; anything far longer is a paste mistake. */
const MAX_KEY_LENGTH = 512;

function sendIfAlive(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(channel, payload);
  } catch {
    // Window can close between the check and the send.
  }
}

function broadcastConfig(config: AppConfig): void {
  sendIfAlive(mainState.mainWindow, 'config-updated', config);
  sendIfAlive(mainState.settingsWindow, 'config-updated', config);
  sendIfAlive(mainState.healthWindow, 'config-updated', config);
  sendIfAlive(mainState.dependenciesWindow, 'config-updated', config);
}

/** Point the pinned Claude row at ``model`` (id, label, context window). */
async function applyClaudeModel(model: AnthropicCatalogModel): Promise<AppConfig> {
  return updateConfig((cfg) => {
    const provider = cfg.llmProviders.find((p) => p.id === PINNED_ANTHROPIC_PROVIDER_ID);
    const profile = provider?.models[0];
    if (!profile) {
      return;
    }
    profile.model = model.id;
    profile.name = model.displayName;
    profile.contextWindowTokens = model.maxInputTokens || inferContextWindowTokens(model.id, 'anthropic');
  });
}

async function publish(config: AppConfig): Promise<void> {
  await syncRuntimeConfigToPython(config, getLlamaManagedRuntimeOverrides(config));
  broadcastConfig(config);
}

/** Picks a model for a fresh key when the Claude row has none yet. */
async function pickDefaultModelIfUnset(models: AnthropicCatalogModel[], config: AppConfig): Promise<AppConfig | null> {
  const provider = config.llmProviders.find((p) => p.id === PINNED_ANTHROPIC_PROVIDER_ID);
  if (!provider || (provider.models[0]?.model ?? '').trim() || !models.length) {
    return null;
  }
  const pick = models.find((m) => m.id === DEFAULT_CLAUDE_MODEL_ID) ?? models.find((m) => !m.deprecated) ?? models[0];
  return applyClaudeModel(pick);
}

export function registerAnthropicIpc(): void {
  ipcMain.handle('anthropic:status', async (event, payload?: { refresh?: boolean }): Promise<AnthropicListModelsResult> => {
    assertTrustedAppRenderer(event);
    return getAnthropicStatus(payload?.refresh === true);
  });

  ipcMain.handle('anthropic:set-api-key', async (event, payload: { apiKey?: unknown }): Promise<AnthropicSetKeyResult> => {
    assertTrustedAppRenderer(event);
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      const { status } = await getAnthropicStatus();
      return { ok: false, error: 'Paste a Claude Console API key (no spaces).', status };
    }
    // Check the key before keeping it. A rejected key is not stored; an outage still saves it.
    let models: AnthropicCatalogModel[] = [];
    let listError = '';
    try {
      models = await listAnthropicModels(key);
    } catch (err) {
      if (isAnthropicAuthError(err)) {
        const { status } = await getAnthropicStatus();
        return { ok: false, error: describeAnthropicError(err), status };
      }
      listError = describeAnthropicError(err);
    }
    await setAnthropicApiKey(key);
    resetAnthropicCatalog();
    const config = await updateConfig(() => undefined);
    const withModel = await pickDefaultModelIfUnset(models, config);
    await publish(withModel ?? config);
    const result = await getAnthropicStatus(!listError);
    return listError ? { ok: false, error: listError, status: result.status } : result;
  });

  ipcMain.handle('anthropic:clear-api-key', async (event): Promise<AnthropicListModelsResult> => {
    assertTrustedAppRenderer(event);
    await clearAnthropicApiKey();
    resetAnthropicCatalog();
    await publish(await updateConfig(() => undefined));
    return getAnthropicStatus();
  });

  ipcMain.handle('anthropic:set-model', async (event, payload: { modelId?: unknown }): Promise<AnthropicSetModelResult> => {
    assertTrustedAppRenderer(event);
    const modelId = typeof payload?.modelId === 'string' ? payload.modelId.trim() : '';
    if (!modelId) {
      return { ok: false, error: 'Missing model id.' };
    }
    const model = await findAnthropicModel(modelId);
    if (!model) {
      return { ok: false, error: `${modelId} is not in this key's model list.` };
    }
    await publish(await applyClaudeModel(model));
    return { ok: true };
  });
}
