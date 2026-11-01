import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig, McpServerConfig } from '../../shared';
import { createEmptyMcpServer, unwrapSecret } from '../../shared';
import {
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  PINNED_ANTHROPIC_PROVIDER_ID,
} from '../../shared';
import { SecretValue } from '../../shared/types/app-config';
import { APP_CONFIG_SCHEMA_VERSION, createDefaultConfig } from './defaults';

vi.mock('../paths', () => ({
  getConfigPath: () => join(process.env.CLARA_TEST_CONFIG_DIR ?? '', 'config.json'),
}));

import { loadConfig, mergeSettingsConfigSave, migrateConfig, updateConfig } from './load-save';

function sampleConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = createDefaultConfig();
  return {
    ...base,
    workspaces: [
      {
        id: 'ws-a',
        name: 'A',
        path: '/tmp/a',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    currentWorkspaceId: 'ws-a',
    lastActiveConversationByWorkspaceId: { 'ws-a': 'conv-a' },
    workspaceMonacoScrollByWorkspaceId: {
      'ws-a': { 'src/a.ts': { scrollTop: 120, scrollLeft: 0 } },
    },
    workspaceOpenTabsByWorkspaceId: {
      'ws-a': {
        tabs: [{ relativePath: 'src/a.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:src/a.ts',
      },
    },
    chatFontSizeRem: 1.1,
    ...overrides,
  };
}

function mcpServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    ...createEmptyMcpServer('srv-1', 'GitHub'),
    command: 'npx',
    args: ['server'],
    headers: [{ key: 'Authorization', value: 'top-secret' as unknown as McpServerConfig['headers'][number]['value'] }],
    toolDecisions: { search: 'deny' },
    ...overrides,
  };
}

describe('screenshot retention config', () => {
  const defaults = { downscaleAfterDays: 7, retentionDays: 30, maxWidth: 1280, maxStorageMiB: 100, maxImages: 200 };

  it('supplies independent defaults for old and new configurations', () => {
    const raw = sampleConfig();
    delete raw.workspaceTools.screenshotRetention;
    expect(migrateConfig(raw).workspaceTools.screenshotRetention).toEqual(defaults);
    expect(createDefaultConfig().workspaceTools.screenshotRetention).toEqual(defaults);
    expect(createDefaultConfig().workspaceTools.screenshotRetention)
      .not.toBe(createDefaultConfig().workspaceTools.screenshotRetention);
  });

  it('normalizes malformed values and keeps reduction strictly before expiry', () => {
    const raw = sampleConfig();
    raw.workspaceTools.screenshotRetention = {
      downscaleAfterDays: 400, retentionDays: 1, maxWidth: 50, maxStorageMiB: 5000, maxImages: -1,
    };
    expect(migrateConfig(raw).workspaceTools.screenshotRetention).toEqual({
      downscaleAfterDays: 1, retentionDays: 2, maxWidth: 320, maxStorageMiB: 1024, maxImages: 10,
    });
    raw.workspaceTools.screenshotRetention = 'bad' as unknown as typeof raw.workspaceTools.screenshotRetention;
    expect(migrateConfig(raw).workspaceTools.screenshotRetention).toEqual(defaults);
  });

  it('preserves saved policy when an older settings client omits the optional field', () => {
    const disk = sampleConfig();
    disk.workspaceTools.screenshotRetention = { ...defaults, retentionDays: 90, maxImages: 800 };
    const client = sampleConfig();
    delete client.workspaceTools.screenshotRetention;
    expect(mergeSettingsConfigSave(disk, client).workspaceTools.screenshotRetention)
      .toEqual(disk.workspaceTools.screenshotRetention);
  });

  it('merges partial retention patches without resetting the saved policy', () => {
    const disk = sampleConfig();
    disk.workspaceTools.screenshotRetention = { ...defaults, retentionDays: 90, maxImages: 800 };
    const client = sampleConfig();
    client.workspaceTools.screenshotRetention = { maxWidth: 640 } as typeof client.workspaceTools.screenshotRetention;
    expect(mergeSettingsConfigSave(disk, client).workspaceTools.screenshotRetention)
      .toEqual({ ...disk.workspaceTools.screenshotRetention, maxWidth: 640 });
  });

  it('round-trips a customized policy through serialized save and load', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-screenshot-config-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const policy = { downscaleAfterDays: 14, retentionDays: 90, maxWidth: 960, maxStorageMiB: 240, maxImages: 700 };
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig()), 'utf-8');
      await updateConfig((cfg) => { cfg.workspaceTools.screenshotRetention = policy; });
      expect((await loadConfig()).workspaceTools.screenshotRetention).toEqual(policy);
      expect(JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8')).workspaceTools.screenshotRetention)
        .toEqual(policy);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('migrateConfig mcp servers', () => {
  it('fills a missing list', () => {
    const raw = sampleConfig();
    delete (raw as { mcpServers?: McpServerConfig[] }).mcpServers;
    const migrated = migrateConfig(raw);
    expect(migrated.mcpServers).toEqual([]);
  });

  it('round-trips a header secret through save and load', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nemo-mcp-config-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig(), null, 2), 'utf-8');
      await updateConfig((cfg) => {
        cfg.mcpServers = [mcpServer()];
      });
      const loaded = await loadConfig();
      expect(loaded.mcpServers).toHaveLength(1);
      expect(unwrapSecret(loaded.mcpServers[0]?.headers[0]?.value)).toBe('top-secret');
      expect(loaded.mcpServers[0]?.toolDecisions).toEqual({ search: 'deny' });
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the OAuth issuing URL and refresh settings, and leaves them empty on older rows', () => {
    const secret = (value: string) => value as unknown as McpServerConfig['headers'][number]['value'];
    const oauth = {
      accessToken: secret('access'),
      refreshToken: secret('refresh'),
      expiresAt: 0,
      clientId: 'client',
      clientSecret: secret(''),
      scopes: [],
    };
    const bound = migrateConfig(
      sampleConfig({
        mcpServers: [
          mcpServer({
            oauth: {
              ...oauth,
              serverUrl: ' https://a.example/mcp ',
              tokenEndpoint: 'https://auth.example/token',
              resource: 'https://a.example/mcp',
              tokenAuthMethod: 'none',
            },
          }),
        ],
      }),
    );
    expect(bound.mcpServers[0]?.oauth).toMatchObject({
      serverUrl: 'https://a.example/mcp',
      tokenEndpoint: 'https://auth.example/token',
      resource: 'https://a.example/mcp',
      tokenAuthMethod: 'none',
    });
    const legacy = migrateConfig(
      sampleConfig({ mcpServers: [mcpServer({ oauth: oauth as unknown as McpServerConfig['oauth'] })] }),
    );
    expect(legacy.mcpServers[0]?.oauth).toMatchObject({ serverUrl: '', tokenEndpoint: '', resource: '', tokenAuthMethod: '' });
  });
});

describe('mergeSettingsConfigSave', () => {
  it('preserves workspace registry fields from disk', () => {
    const disk = sampleConfig();
    const client = sampleConfig({
      workspaces: [],
      currentWorkspaceId: null,
      lastActiveConversationByWorkspaceId: {},
      workspaceOpenTabsByWorkspaceId: {},
      chatFontSizeRem: 1.4,
    });

    const merged = mergeSettingsConfigSave(disk, client);
    expect(merged.workspaces).toEqual(disk.workspaces);
    expect(merged.currentWorkspaceId).toBe('ws-a');
    expect(merged.lastActiveConversationByWorkspaceId).toEqual({ 'ws-a': 'conv-a' });
    expect(merged.workspaceMonacoScrollByWorkspaceId).toEqual({
      'ws-a': { 'src/a.ts': { scrollTop: 120, scrollLeft: 0 } },
    });
    expect(merged.workspaceOpenTabsByWorkspaceId).toEqual({
      'ws-a': {
        tabs: [{ relativePath: 'src/a.ts', outsideWorkspace: false }],
        activeTabId: 'file:rel:src/a.ts',
      },
    });
    expect(merged.chatFontSizeRem).toBe(1.4);
  });

  it('keeps chat-time MCP decisions when the settings snapshot did not edit them', () => {
    const disk = sampleConfig({
      mcpServers: [mcpServer({ trust: 'allow-all', toolDecisions: { search: 'allow' }, oauth: null })],
    });
    const client = sampleConfig({
      mcpServers: [mcpServer({ name: 'Renamed', trust: 'ask', toolDecisions: { search: 'deny' } })],
    });
    const merged = mergeSettingsConfigSave(disk, client);
    expect(merged.mcpServers[0]?.name).toBe('Renamed');
    expect(merged.mcpServers[0]?.trust).toBe('allow-all');
    expect(merged.mcpServers[0]?.toolDecisions).toEqual({ search: 'allow' });
  });

  it('uses MCP decisions the settings window actually edited', () => {
    const disk = sampleConfig({
      mcpServers: [mcpServer({ toolDecisions: { search: 'allow' } })],
    });
    const client = sampleConfig({
      mcpServers: [mcpServer({ toolDecisions: { search: 'deny' }, toolDecisionsTouched: true })],
    });
    const merged = mergeSettingsConfigSave(disk, client);
    expect(merged.mcpServers[0]?.toolDecisions).toEqual({ search: 'deny' });
    expect(merged.mcpServers[0]?.toolDecisionsTouched).toBeUndefined();
  });
});

describe('updateConfig serialization', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nemo-config-test-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig(), null, 2), 'utf-8');
  });

  afterEach(() => {
    delete process.env.CLARA_TEST_CONFIG_DIR;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent mutations without losing workspace additions', async () => {
    await Promise.all([
      updateConfig((cfg) => {
        cfg.workspaces.push({
          id: 'ws-b',
          name: 'B',
          path: '/tmp/b',
          createdAt: '2026-01-02T00:00:00.000Z',
        });
      }),
      updateConfig((cfg) => {
        cfg.lastActiveConversationByWorkspaceId = {
          ...(cfg.lastActiveConversationByWorkspaceId ?? {}),
          'ws-a': 'conv-updated',
        };
      }),
      updateConfig((cfg) => {
        cfg.chatFontSizeRem = 1.25;
      }),
    ]);

    const saved = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8')) as AppConfig;
    expect(saved.workspaces.map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b']);
    expect(saved.lastActiveConversationByWorkspaceId?.['ws-a']).toBe('conv-updated');
    expect(saved.chatFontSizeRem).toBe(1.25);
    expect(existsSync(join(tempDir, 'config.json.bak'))).toBe(true);
  });

  it('loadConfig returns persisted config without resetting on retryable read races', async () => {
    const loaded = await loadConfig();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe('ws-a');
  });
});

describe('migrateConfig default home page', () => {
  it('defaults a missing defaultHomePageOnStart flag to false', () => {
    const cfg = sampleConfig();
    delete cfg.defaultHomePageOnStart;
    const migrated = migrateConfig(cfg);
    expect(migrated.defaultHomePageOnStart).toBe(false);
  });

  it('keeps a persisted defaultHomePageOnStart preference', () => {
    const cfg = sampleConfig({ defaultHomePageOnStart: true });
    const migrated = migrateConfig(cfg);
    expect(migrated.defaultHomePageOnStart).toBe(true);
  });
});

describe('migrateConfig chat window state', () => {
  it('defaults missing chat chrome flags to false', () => {
    const cfg = sampleConfig();
    delete cfg.chatSidebarCollapsed;
    delete cfg.chatExpandedToMainPanel;
    const migrated = migrateConfig(cfg);
    expect(migrated.chatSidebarCollapsed).toBe(false);
    expect(migrated.chatExpandedToMainPanel).toBe(false);
  });

  it('clears expanded overlay when the sidebar is collapsed', () => {
    const cfg = sampleConfig({
      chatSidebarCollapsed: true,
      chatExpandedToMainPanel: true,
    });
    const migrated = migrateConfig(cfg);
    expect(migrated.chatSidebarCollapsed).toBe(true);
    expect(migrated.chatExpandedToMainPanel).toBe(false);
  });

  it('keeps a valid open + expanded layout', () => {
    const cfg = sampleConfig({
      chatSidebarCollapsed: false,
      chatExpandedToMainPanel: true,
    });
    const migrated = migrateConfig(cfg);
    expect(migrated.chatSidebarCollapsed).toBe(false);
    expect(migrated.chatExpandedToMainPanel).toBe(true);
  });
});

describe('migrateConfig audio', () => {
  it('defaults new audio to local whisper', () => {
    const cfg = createDefaultConfig();
    expect(cfg.audioTranscription.provider).toBe('whisper');
    expect(cfg.audioTranscription.model).toBe('small');
  });

  it('migrates google STT to local whisper', () => {
    const cfg = sampleConfig();
    (cfg.audioTranscription as { provider: string }).provider = 'google';
    cfg.audioTranscription.model = 'google-web-speech';
    const migrated = migrateConfig(cfg);
    expect(migrated.audioTranscription.provider).toBe('whisper');
    expect(migrated.audioTranscription.model).toBe('small');
  });
});

describe('migrateConfig workspace tools extraUserPath', () => {
  it('defaults missing extraUserPath to empty string', () => {
    const cfg = sampleConfig();
    delete cfg.workspaceTools.extraUserPath;
    const migrated = migrateConfig(cfg);
    expect(migrated.workspaceTools.extraUserPath).toBe('');
  });
});

describe('migrateConfig workspace tools enableAgentFormatters', () => {
  it('defaults missing enableAgentFormatters to false', () => {
    const cfg = sampleConfig();
    delete cfg.workspaceTools.enableAgentFormatters;
    const migrated = migrateConfig(cfg);
    expect(migrated.workspaceTools.enableAgentFormatters).toBe(false);
  });
});

describe('migrateConfig monaco hover delay', () => {
  it('bumps the previous 300ms default so hover is less eager', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor,
      hoverDelay: 300,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor.hoverDelay).toBe(500);
  });

  it('keeps a custom hover delay', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor,
      hoverDelay: 800,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor.hoverDelay).toBe(800);
  });
});

describe('migrateConfig monaco top padding', () => {
  it('bumps the previous 0px default to 20px when migrating from schema 6', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 6;
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor,
      paddingTop: 0,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor.paddingTop).toBe(20);
    expect(migrated.configSchemaVersion).toBe(APP_CONFIG_SCHEMA_VERSION);
  });

  it('keeps a custom top padding', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 6;
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor,
      paddingTop: 8,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor.paddingTop).toBe(8);
  });

  it('keeps 0px when the user chose it after the migration ran', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor,
      paddingTop: 0,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor.paddingTop).toBe(0);
  });
});

describe('migrateConfig parallel tool calls', () => {
  it('defaults new profiles to on', () => {
    const cfg = sampleConfig();
    for (const provider of cfg.llmProviders) {
      for (const model of provider.models) {
        expect(model.parallelToolCalls).toBe(true);
      }
    }
  });

  it('turns parked-off profiles on when migrating from schema 5', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 5;
    for (const provider of cfg.llmProviders) {
      for (const model of provider.models) {
        model.parallelToolCalls = false;
      }
    }
    const migrated = migrateConfig(cfg);
    expect(migrated.configSchemaVersion).toBe(APP_CONFIG_SCHEMA_VERSION);
    for (const provider of migrated.llmProviders) {
      for (const model of provider.models) {
        expect(model.parallelToolCalls).toBe(true);
      }
    }
  });

  it('keeps the flag off when the user disabled it after unpark', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 6;
    const first = cfg.llmProviders[0]?.models[0];
    expect(first).toBeDefined();
    first!.parallelToolCalls = false;
    const migrated = migrateConfig(cfg);
    expect(migrated.llmProviders[0]?.models[0]?.parallelToolCalls).toBe(false);
  });
});

describe('migrateConfig openrouter pin', () => {
  it('inserts the pinned OpenRouter source without changing the active model', () => {
    const cfg = sampleConfig();
    const local = cfg.llmProviders.find((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID);
    const active = local?.models[0]?.id ?? '';
    expect(active).not.toBe('');
    cfg.activeLlmModelId = active;
    cfg.llmProviders = cfg.llmProviders.filter((p) => p.id !== PINNED_OPENROUTER_PROVIDER_ID);
    const migrated = migrateConfig(cfg);
    const openrouter = migrated.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
    expect(openrouter?.provider).toBe('openrouter');
    expect(openrouter?.name).toBe('OpenRouter');
    expect(openrouter?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(openrouter?.models[0]?.model).toBe('');
    expect(migrated.activeLlmModelId).toBe(active);
    const localIdx = migrated.llmProviders.findIndex((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID);
    expect(migrated.llmProviders[localIdx + 1]?.id).toBe(PINNED_OPENROUTER_PROVIDER_ID);
  });

  it('keeps the pinned OpenRouter model empty across repeated migrations', () => {
    const cfg = sampleConfig();
    cfg.llmProviders = cfg.llmProviders.filter((p) => p.id !== PINNED_OPENROUTER_PROVIDER_ID);
    // loadConfig migrates the parsed file, then migrates the result again.
    const twice = migrateConfig(migrateConfig(cfg));
    const openrouter = twice.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
    expect(openrouter?.models[0]?.model).toBe('');
  });

  it('keeps a cleared OpenRouter model through save and load', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nemo-openrouter-config-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    const modelOf = (cfg: AppConfig) =>
      cfg.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID)?.models[0]?.model;
    try {
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig(), null, 2), 'utf-8');
      expect(modelOf(await loadConfig())).toBe('');
      await updateConfig((cfg) => {
        const row = cfg.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
        row!.models[0]!.model = 'anthropic/claude-sonnet-4.5';
      });
      expect(modelOf(await loadConfig())).toBe('anthropic/claude-sonnet-4.5');
      await updateConfig((cfg) => {
        const row = cfg.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
        row!.models[0]!.model = '';
      });
      expect(modelOf(await loadConfig())).toBe('');
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a customized OpenRouter row instead of rewriting it to OpenAI, but restores its fixed name', () => {
    const cfg = sampleConfig();
    const row = cfg.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
    expect(row).toBeDefined();
    row!.name = 'My Router';
    row!.baseUrl = 'https://openrouter.ai/api';
    row!.models[0]!.model = 'anthropic/claude-sonnet-4.5';
    const active = cfg.activeLlmModelId;
    const migrated = migrateConfig(cfg);
    const openrouter = migrated.llmProviders.find((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
    expect(openrouter?.provider).toBe('openrouter');
    expect(openrouter?.name).toBe('OpenRouter');
    expect(openrouter?.baseUrl).toBe('https://openrouter.ai/api');
    expect(openrouter?.models[0]?.model).toBe('anthropic/claude-sonnet-4.5');
    expect(migrated.activeLlmModelId).toBe(active);
  });
});

describe('migrateConfig managed llama source names', () => {
  it('renames old default names on local sources to numbered Local Model names', () => {
    const cfg = sampleConfig();
    const local = cfg.llmProviders.find((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID)!;
    local.name = 'Llama server (local)';
    cfg.llmProviders.push({ ...structuredClone(local), id: 'extra-local', name: 'Llama Server 2' });
    const migrated = migrateConfig(cfg);
    expect(migrated.llmProviders.find((p) => p.id === PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID)?.name).toBe('Local Model');
    expect(migrated.llmProviders.find((p) => p.id === 'extra-local')?.name).toBe('Local Model 2');
  });

  it('keeps the remote URL source name', () => {
    const migrated = migrateConfig(sampleConfig());
    expect(migrated.llmProviders.find((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID)?.name).toBe(
      'Llama server (URL)',
    );
  });
});

describe('migrateConfig Claude pin', () => {
  const claudeOf = (cfg: AppConfig) => cfg.llmProviders.find((p) => p.id === PINNED_ANTHROPIC_PROVIDER_ID);

  it('inserts the pinned Claude source after OpenRouter without changing the active model', () => {
    const cfg = sampleConfig();
    const active = cfg.activeLlmModelId;
    cfg.llmProviders = cfg.llmProviders.filter((p) => p.id !== PINNED_ANTHROPIC_PROVIDER_ID);
    const migrated = migrateConfig(cfg);
    const claude = claudeOf(migrated);
    expect(claude?.provider).toBe('anthropic');
    expect(claude?.name).toBe('Claude');
    expect(claude?.models[0]?.model).toBe('');
    expect(migrated.activeLlmModelId).toBe(active);
    const orIdx = migrated.llmProviders.findIndex((p) => p.id === PINNED_OPENROUTER_PROVIDER_ID);
    expect(migrated.llmProviders[orIdx + 1]?.id).toBe(PINNED_ANTHROPIC_PROVIDER_ID);
  });

  it('never carries or writes a Claude API key in the config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-claude-config-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig(), null, 2), 'utf-8');
      await loadConfig();
      const saved = await updateConfig((cfg) => {
        claudeOf(cfg)!.apiKey = SecretValue.of('sk-ant-should-not-persist');
      });
      expect(unwrapSecret(claudeOf(saved)!.apiKey)).toBe('');
      expect(readFileSync(join(tempDir, 'config.json'), 'utf-8')).not.toContain('sk-ant-should-not-persist');
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the saved Claude model when a stale Settings draft is applied', () => {
    const disk = sampleConfig();
    const diskRow = claudeOf(disk)!;
    diskRow.models[0] = { ...diskRow.models[0]!, model: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindowTokens: 1_000_000 };
    const client = structuredClone(sampleConfig());
    const clientRow = claudeOf(client)!;
    clientRow.models[0] = { ...clientRow.models[0]!, model: 'claude-sonnet-5-5', reasoningEffort: 'high' };
    const merged = mergeSettingsConfigSave(disk, client);
    const row = claudeOf(merged)!.models[0]!;
    expect(row.model).toBe('claude-opus-5-5');
    expect(row.name).toBe('Claude Opus 5.5');
    expect(row.contextWindowTokens).toBe(1_000_000);
    // Fields Settings owns still come from the client.
    expect(row.reasoningEffort).toBe('high');
  });
});
