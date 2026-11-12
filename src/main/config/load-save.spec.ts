import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, promises as fs, readdirSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig, ContextCompressionConfig, LlamaCppManaged, McpServerConfig } from '../../shared';
import { createEmptyMcpServer, getDefaultContextCompression, isPinnedLlmSourceId, unwrapSecret } from '../../shared';
import {
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  PINNED_OPENROUTER_PROVIDER_ID,
  PINNED_ANTHROPIC_PROVIDER_ID,
} from '../../shared';
import { SecretValue } from '../../shared/types/app-config';
import { APP_CONFIG_SCHEMA_VERSION, createDefaultConfig } from './defaults';

const isLocalSource = (p: AppConfig['llmProviders'][number]) => p.provider === 'llamacpp' && !isPinnedLlmSourceId(p.id);

vi.mock('../paths', () => ({
  getConfigPath: () => join(process.env.CLARA_TEST_CONFIG_DIR ?? '', 'config.json'),
}));

import { loadConfig, loadConfigSync, loadTutorialProgress, mergeSettingsConfigSave, migrateConfig, saveConfig, updateConfig, updateTutorialProgress } from './load-save';
import { applyTutorialTransition, isTutorialPhaseResolved, normalizeTutorialProgress, TUTORIAL_PHASE_REGISTRY } from '../../shared/types/tutorial';

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

describe('migrateConfig workspace tools turn verification', () => {
  it('defaults missing settings to on with two fix rounds', () => {
    const cfg = sampleConfig();
    delete cfg.workspaceTools.verifyAfterEdits;
    delete cfg.workspaceTools.verifyMaxFixRounds;
    const migrated = migrateConfig(cfg);
    expect(migrated.workspaceTools.verifyAfterEdits).toBe(true);
    expect(migrated.workspaceTools.verifyMaxFixRounds).toBe(2);
  });

  it('keeps an explicit off and clamps the fix rounds', () => {
    const cfg = sampleConfig();
    cfg.workspaceTools.verifyAfterEdits = false;
    cfg.workspaceTools.verifyMaxFixRounds = 9.6;
    const migrated = migrateConfig(cfg);
    expect(migrated.workspaceTools.verifyAfterEdits).toBe(false);
    expect(migrated.workspaceTools.verifyMaxFixRounds).toBe(5);
  });
});

describe('migrateConfig monaco hover delay', () => {
  it('bumps the previous 300ms default so hover is less eager', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor!,
      hoverDelay: 300,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor?.hoverDelay).toBe(500);
  });

  it('keeps a custom hover delay', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor!,
      hoverDelay: 800,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor?.hoverDelay).toBe(800);
  });
});

describe('migrateConfig monaco top padding', () => {
  it('bumps the previous 0px default to 20px when migrating from schema 6', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 6;
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor!,
      paddingTop: 0,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor?.paddingTop).toBe(20);
    expect(migrated.configSchemaVersion).toBe(APP_CONFIG_SCHEMA_VERSION);
  });

  it('keeps a custom top padding', () => {
    const cfg = sampleConfig();
    cfg.configSchemaVersion = 6;
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor!,
      paddingTop: 8,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor?.paddingTop).toBe(8);
  });

  it('keeps 0px when the user chose it after the migration ran', () => {
    const cfg = sampleConfig();
    cfg.monacoWorkspaceEditor = {
      ...cfg.monacoWorkspaceEditor!,
      paddingTop: 0,
    };
    const migrated = migrateConfig(cfg);
    expect(migrated.monacoWorkspaceEditor?.paddingTop).toBe(0);
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

describe('migrateConfig context compaction', () => {
  const oldDefaults = (): ContextCompressionConfig => ({ enabled: false, triggerRatio: 0.7, targetRatio: 0.55 });

  function atSchema8(contextCompression: ContextCompressionConfig): AppConfig {
    return sampleConfig({ configSchemaVersion: 8, contextCompression });
  }

  it('turns a schema 8 config on', () => {
    const migrated = migrateConfig(atSchema8(oldDefaults()));
    expect(migrated.contextCompression.enabled).toBe(true);
    expect(migrated.configSchemaVersion).toBe(APP_CONFIG_SCHEMA_VERSION);
  });

  it('keeps off at schema 9', () => {
    const contextCompression = { enabled: false, triggerRatio: 0.8, targetRatio: 0.5 };
    const migrated = migrateConfig(sampleConfig({ configSchemaVersion: 9, contextCompression }));
    expect(migrated.contextCompression.enabled).toBe(false);
  });

  it('moves the old default ratios', () => {
    expect(migrateConfig(atSchema8(oldDefaults())).contextCompression).toEqual(getDefaultContextCompression());
    const withOldSettings = { ...oldDefaults(), protectTailMessages: 24, recentToolBodyMaxChars: 2000, oldToolBodyMaxChars: 400, systemReserveRatio: 0.25 };
    expect(migrateConfig(atSchema8(withOldSettings)).contextCompression).toEqual(getDefaultContextCompression());
  });

  it('keeps custom ratios', () => {
    const migrated = migrateConfig(atSchema8({ enabled: false, triggerRatio: 0.85, targetRatio: 0.6 }));
    expect(migrated.contextCompression).toEqual({ enabled: true, triggerRatio: 0.85, targetRatio: 0.6 });
  });

  it('fills in a missing object', () => {
    const cfg = atSchema8(oldDefaults());
    delete (cfg as Partial<AppConfig>).contextCompression;
    expect(migrateConfig(cfg).contextCompression).toEqual(getDefaultContextCompression());
    const empty = sampleConfig({ contextCompression: {} as ContextCompressionConfig });
    expect(migrateConfig(empty).contextCompression).toEqual(getDefaultContextCompression());
  });

  it('runs once: choices made after the first migration survive the next', () => {
    const first = migrateConfig(atSchema8(oldDefaults()));
    first.contextCompression = oldDefaults();
    expect(migrateConfig(first).contextCompression).toEqual(oldDefaults());
  });

  it('keeps a 0.1 gap under the trigger, rounded', () => {
    const contextCompression = { enabled: true, triggerRatio: 0.55, targetRatio: 0.55 };
    const migrated = migrateConfig(sampleConfig({ contextCompression }));
    expect(migrated.contextCompression.targetRatio).toBe(0.45);
    const atGap = { enabled: true, triggerRatio: 0.8, targetRatio: 0.7 };
    expect(migrateConfig(sampleConfig({ contextCompression: atGap })).contextCompression.targetRatio).toBe(0.7);
  });
});

describe('migrateConfig managed --cache-ram 0', () => {
  const tuned = { c: 65536, ctk: 'q8_0', ctv: 'q8_0' };

  function managedAfterMigration(chatRunCommand: string, configSchemaVersion = 8): LlamaCppManaged {
    const cfg = sampleConfig({ configSchemaVersion });
    const local = cfg.llmProviders.find(isLocalSource)!;
    local.models[0]!.llamaCppManaged = { chatRunCommand, embeddingRunCommand: 'embed --cache-ram 0', autoTuned: tuned };
    const migrated = migrateConfig(cfg);
    return migrated.llmProviders.find(isLocalSource)!.models[0]!.llamaCppManaged!;
  }

  it('drops the flag the builder wrote and nothing else', () => {
    const managed = managedAfterMigration(
      'llama-server --port {{PORT}} -m /a.gguf -c 0 --metrics -np 1 --no-webui --cache-ram 0',
    );
    expect(managed.chatRunCommand).toBe('llama-server --port {{PORT}} -m /a.gguf -c 0 --metrics -np 1 --no-webui');
    expect(managed.embeddingRunCommand).toBe('embed --cache-ram 0');
    expect(managed.autoTuned).toEqual(tuned);
  });

  it('keeps flags added after it', () => {
    expect(
      managedAfterMigration('llama-server -np 1 --no-webui --cache-ram 0 --reasoning-format none').chatRunCommand,
    ).toBe('llama-server -np 1 --no-webui --reasoning-format none');
  });

  it.each([
    'llama-server -np 1 --no-webui --cache-ram -1',
    'llama-server -np 1 --no-webui --cache-ram 8192',
    'llama-server -np 1 --no-webui -cram 0',
    'llama-server --no-webui -np 1 --cache-ram 0',
    'llama-server --cache-ram 0 -np 1 --no-webui',
  ])('leaves %s untouched', (command) => {
    expect(managedAfterMigration(command).chatRunCommand).toBe(command);
  });

  it('runs once: the same flags added at schema 9 stay', () => {
    const command = 'llama-server -np 1 --no-webui --cache-ram 0';
    expect(managedAfterMigration(command, 9).chatRunCommand).toBe(command);
  });

  it('leaves the user preset byte for byte, with no plan on file', () => {
    const preset =
      'llama-server --host 127.0.0.1 --port {{PORT}} --jinja -m /m/swift.gguf -c 128000 -np 1 --cache-ram -1 -fa on ' +
      '-ctk q8_0 -ctv q8_0 --metrics --no-webui --spec-draft-n-max 4 --spec-type draft-mtp -dev CUDA0,CUDA1 ' +
      '--tensor-split 27,21 --main-gpu 0 -ngl auto --no-mmproj --load-mode auto';
    const cfg = sampleConfig({ configSchemaVersion: 8 });
    const local = cfg.llmProviders.find(isLocalSource)!;
    local.models[0]!.llamaCppManaged = { chatRunCommand: preset, embeddingRunCommand: '' };
    const managed = migrateConfig(cfg).llmProviders.find(isLocalSource)!.models[0]!
      .llamaCppManaged!;
    expect(managed.chatRunCommand).toBe(preset);
    expect(managed.autoTuned).toBeUndefined();
  });
});

describe('migrateConfig LM Studio name', () => {
  const pinnedName = (name: string) => {
    const cfg = sampleConfig();
    cfg.llmProviders.find((p) => p.provider === 'lmstudio')!.name = name;
    return migrateConfig(cfg).llmProviders.find((p) => p.provider === 'lmstudio')?.name;
  };

  it('starts a new config as LM Studio', () => {
    expect(createDefaultConfig().llmProviders.find((p) => p.provider === 'lmstudio')?.name).toBe('LM Studio');
  });

  it('renames the old default', () => {
    expect(pinnedName('LM Studio Default')).toBe('LM Studio');
  });

  it('keeps a name the user chose', () => {
    expect(pinnedName('Workstation')).toBe('Workstation');
  });
});

describe('the OpenAI-compatible source', () => {
  const urlSource = (cfg: AppConfig) => cfg.llmProviders.find((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID)!;

  it('starts a new config with its own source type, no invented model and no embeddings server', () => {
    const source = urlSource(createDefaultConfig());
    expect(source.provider).toBe('openai-compatible');
    expect(source.models[0]?.model).toBe('');
    expect(source.embeddingsBaseUrl).toBeUndefined();
  });

  it('moves a saved llamacpp row to the new type, keeping its URL and model', () => {
    const cfg = sampleConfig();
    const source = urlSource(cfg);
    source.provider = 'llamacpp';
    source.baseUrl = 'https://x.dev/v1';
    source.models[0]!.model = 'my-model';
    const migrated = urlSource(migrateConfig(cfg));
    expect(migrated.provider).toBe('openai-compatible');
    expect(migrated.baseUrl).toBe('https://x.dev/v1');
    expect(migrated.models[0]?.model).toBe('my-model');
  });

  const migrateUrl = (baseUrl: string) => {
    const cfg = sampleConfig();
    const source = urlSource(cfg);
    source.provider = 'llamacpp';
    source.baseUrl = baseUrl;
    return urlSource(migrateConfig(cfg));
  };

  it('keeps sending a saved row to the same address, which used to get /v1 added', () => {
    expect(migrateUrl('http://proxy/lms').baseUrl).toBe('http://proxy/lms/v1');
    expect(migrateUrl('http://host:8080/').baseUrl).toBe('http://host:8080/v1');
    expect(migrateUrl('192.168.1.10:8080').baseUrl).toBe('http://192.168.1.10:8080/v1');
    expect(migrateUrl('').baseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('moves user:pw@ from a saved row into the header it was sending', () => {
    const migrated = migrateUrl('http://u%40x:p@host/v1');
    expect(migrated.baseUrl).toBe('http://host/v1');
    expect(migrated.customHeaders?.map((h) => [h.key, unwrapSecret(h.value)])).toEqual([
      ['Authorization', `Basic ${Buffer.from('u@x:p').toString('base64')}`],
    ]);
  });

  it('leaves a saved row with an unusable URL for its screen to flag', () => {
    expect(migrateUrl('http://[bad').baseUrl).toBe('http://[bad');
  });

  it('leaves a URL alone once the source has the new type', () => {
    const cfg = sampleConfig();
    urlSource(cfg).provider = 'openai-compatible';
    urlSource(cfg).baseUrl = 'http://proxy/custom';
    expect(urlSource(migrateConfig(cfg)).baseUrl).toBe('http://proxy/custom');
  });

  it('leaves managed local sources as llamacpp', () => {
    const migrated = migrateConfig(sampleConfig());
    const local = migrated.llmProviders.find(isLocalSource);
    expect(local?.provider).toBe('llamacpp');
  });

  it('accepts the type on a save', () => {
    const cfg = sampleConfig();
    urlSource(cfg).provider = 'openai-compatible';
    expect(urlSource(migrateConfig(cfg)).provider).toBe('openai-compatible');
  });

  it('keeps settings, and repairs invalid values', () => {
    const cfg = sampleConfig();
    (urlSource(cfg).models[0] as { openAiCompat?: unknown }).openAiCompat = { tokensField: 'bogus', seed: 7, sendTemperature: false };
    const compat = urlSource(migrateConfig(cfg)).models[0]?.openAiCompat;
    expect(compat).toMatchObject({ tokensField: 'max_tokens', seed: 7, sendTemperature: false, streamUsage: true });
  });

  describe('custom headers', () => {
    const withHeaders = (headers: unknown) => {
      const cfg = sampleConfig();
      (urlSource(cfg) as { customHeaders?: unknown }).customHeaders = headers;
      return urlSource(migrateConfig(cfg));
    };

    it('wrap values as secrets, from a plain string or a String object', () => {
      const headers = withHeaders([{ key: 'api-key', value: 'abc' }, { key: 'b', value: new String('def') }]).customHeaders!;
      expect(headers.map((h) => h.key)).toEqual(['api-key', 'b']);
      expect(headers.map((h) => unwrapSecret(h.value))).toEqual(['abc', 'def']);
      expect(JSON.stringify(headers)).not.toContain('abc');
    });

    it('go through the same disk encryption as API keys', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'clara-headers-'));
      process.env.CLARA_TEST_CONFIG_DIR = tempDir;
      try {
        const cfg = sampleConfig();
        urlSource(cfg).customHeaders = [{ key: 'api-key', value: SecretValue.of('hdr-secret') }];
        await saveConfig(cfg);
        const onDisk = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8')) as AppConfig;
        const stored = urlSource(onDisk).customHeaders as unknown as { key: string; value: unknown }[];
        // No keychain in tests, so this is the plaintext fallback; what matters is the value is written as a string.
        expect(stored).toEqual([{ key: 'api-key', value: 'hdr-secret' }]);
        const loaded = await loadConfig();
        expect(urlSource(loaded).customHeaders?.map((h) => unwrapSecret(h.value))).toEqual(['hdr-secret']);
      } finally {
        delete process.env.CLARA_TEST_CONFIG_DIR;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe('migrateConfig LM Studio settings', () => {
  const migrate = (lmStudio: unknown) => {
    const cfg = sampleConfig();
    (cfg.llmProviders.find((p) => p.provider === 'lmstudio')!.models[0] as { lmStudio?: unknown }).lmStudio = lmStudio;
    return migrateConfig(cfg).llmProviders.find((p) => p.provider === 'lmstudio')!.models[0]!.lmStudio;
  };

  it('keeps saved settings', () => {
    const saved = { contextLength: 65536, parallel: 2, evalBatchSize: 512, flashAttention: false, offloadKvCacheToGpu: false, autoLoad: false, idleTtlSeconds: 300 };
    expect(migrate(saved)).toEqual(saved);
  });

  it('repairs invalid values', () => {
    expect(migrate({ contextLength: -1, parallel: 'many' })).toMatchObject({ contextLength: 32768, parallel: 4 });
  });

  it('adds nothing to a profile that never set any', () => {
    expect(migrate(undefined)).toBeUndefined();
  });
});

describe('migrateConfig openrouter pin', () => {
  it('inserts the pinned OpenRouter source without changing the active model', () => {
    const cfg = sampleConfig();
    const local = cfg.llmProviders.find(isLocalSource);
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
    const urlIdx = migrated.llmProviders.findIndex((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID);
    expect(migrated.llmProviders[urlIdx + 1]?.id).toBe(PINNED_OPENROUTER_PROVIDER_ID);
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

describe('local model sources', () => {
  it('starts a new config with one ordinary local source after the pinned rows', () => {
    const first = createDefaultConfig().llmProviders;
    const locals = first.filter(isLocalSource);
    expect(locals).toHaveLength(1);
    expect(first.at(-1)).toBe(locals[0]);
    expect(isPinnedLlmSourceId(locals[0]!.id)).toBe(false);
    expect(createDefaultConfig().llmProviders.find(isLocalSource)?.id).not.toBe(locals[0]!.id);
  });

  it('keeps a removed local source removed', () => {
    const cfg = sampleConfig();
    cfg.llmProviders = cfg.llmProviders.filter((p) => !isLocalSource(p));
    expect(migrateConfig(cfg).llmProviders.some(isLocalSource)).toBe(false);
  });

  it('keeps the old default local row as an ordinary source with its settings', () => {
    const cfg = sampleConfig();
    const local = cfg.llmProviders.find(isLocalSource)!;
    local.id = 'llamacpp-local-default';
    local.models[0]!.llamaCppManaged = { chatRunCommand: 'llama-server -m /a.gguf', embeddingRunCommand: '' };
    cfg.activeLlmModelId = local.models[0]!.id;
    const migrated = migrateConfig(cfg);
    const kept = migrated.llmProviders.find((p) => p.id === 'llamacpp-local-default');
    expect(kept?.models[0]?.llamaCppManaged?.chatRunCommand).toBe('llama-server -m /a.gguf');
    expect(isPinnedLlmSourceId('llamacpp-local-default')).toBe(false);
    expect(migrated.activeLlmModelId).toBe(local.models[0]!.id);
  });
});

describe('migrateConfig managed llama source names', () => {
  it('renames old default names on local sources to numbered Local Model names', () => {
    const cfg = sampleConfig();
    const local = cfg.llmProviders.find(isLocalSource)!;
    local.name = 'Llama server (local)';
    cfg.llmProviders.push({ ...structuredClone(local), id: 'extra-local', name: 'Llama Server 2' });
    const migrated = migrateConfig(cfg);
    expect(migrated.llmProviders.find(isLocalSource)?.name).toBe('Local Model');
    expect(migrated.llmProviders.find((p) => p.id === 'extra-local')?.name).toBe('Local Model 2');
  });

  const urlSourceNameAfterMigrating = (name: string) => {
    const cfg = sampleConfig();
    cfg.llmProviders.find((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID)!.name = name;
    return migrateConfig(cfg).llmProviders.find((p) => p.id === PINNED_LLAMA_SERVER_URL_PROVIDER_ID)?.name;
  };

  it('renames old default names on the remote URL source', () => {
    expect(urlSourceNameAfterMigrating('Llama server (URL)')).toBe('Custom OpenAI Endpoint');
    expect(urlSourceNameAfterMigrating('llama.cpp')).toBe('Custom OpenAI Endpoint');
  });

  it('keeps a name the user gave the remote URL source', () => {
    expect(urlSourceNameAfterMigrating('My GPU box')).toBe('My GPU box');
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
        claudeOf(cfg)!.apiKey = SecretValue.of('claude-key-should-not-persist');
      });
      expect(unwrapSecret(claudeOf(saved)!.apiKey)).toBe('');
      expect(readFileSync(join(tempDir, 'config.json'), 'utf-8')).not.toContain('claude-key-should-not-persist');
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

describe('durable tutorial progress', () => {
  it('migrates an older config without changing its workspace or unrelated settings', () => {
    const raw = sampleConfig({ themeId: 'clara-light', chatFontSizeRem: 1.25 });
    delete raw.tutorial;
    const migrated = migrateConfig(raw);
    expect(migrated.tutorial).toEqual({ revision: 0, phases: {}, active: null });
    expect(migrated.workspaces).toEqual(raw.workspaces);
    expect(migrated.currentWorkspaceId).toBe('ws-a');
    expect(migrated.themeId).toBe('clara-light');
    expect(migrated.chatFontSizeRem).toBe(1.25);
    expect(createDefaultConfig().tutorial).not.toBe(createDefaultConfig().tutorial);
  });

  it('retains future phase records, extension fields, and an unknown future cursor', () => {
    const raw = sampleConfig();
    raw.tutorial = {
      revision: 6,
      phases: { future: { status: 'new-format', note: 'keep' } } as never,
      active: { phaseId: 'future', stepId: 'next-version-step' },
      extra: { data: 7 },
    } as never;
    const progress = migrateConfig(raw).tutorial!;
    expect(progress.phases.future).toEqual({ status: 'new-format', note: 'keep' });
    expect((progress as unknown as { extra: unknown }).extra).toEqual({ data: 7 });
    const result = applyTutorialTransition(progress, { action: 'advance', expectedRevision: 6 });
    expect(result.applied).toBe(false);
    expect(result.progress.active).toEqual({ phaseId: 'future', stepId: 'next-version-step' });
  });

  it('does not discard an unknown step added to a known phase by a newer version', () => {
    const progress = {
      revision: 4,
      phases: {},
      active: { phaseId: 'intro', stepId: 'future-intro-step' },
    };
    const result = applyTutorialTransition(progress, { action: 'dismiss-all', expectedRevision: 4 });
    expect(result.progress.active).toEqual(progress.active);
    expect(result.progress.phases['intro']).toBeUndefined();
    expect(result.progress.phases['local-engine']).toBe('dismissed');
  });

  it('records only a source ID and permits a revision-checked, explicit recovery', () => {
    const current = {
      revision: 3,
      phases: { intro: 'completed', 'local-engine': 'skipped', 'featured-models': 'completed' },
      active: { phaseId: 'local-source', stepId: 'sources-add' },
    } as const;
    const next = applyTutorialTransition(current, { action: 'advance', expectedRevision: 3, sourceId: 'draft-123' });
    expect(next.progress.active?.stepId).toBe('sources-model');
    expect(next.progress.sourceId).toBe('draft-123');
    const stale = applyTutorialTransition(next.progress, { action: 'recover-source', expectedRevision: 3 });
    expect(stale.applied).toBe(false);
    const recovered = applyTutorialTransition(next.progress, { action: 'recover-source', expectedRevision: 4 });
    expect(recovered.progress.active?.stepId).toBe('sources-add');
    expect(recovered.progress.sourceId).toBeUndefined();
    expect(recovered.progress.revision).toBe(5);
  });

  it('preserves ciphertext and every unrelated raw field across tutorial steps', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-secrets-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const disk = JSON.parse(JSON.stringify(sampleConfig())) as Record<string, any>;
      disk.llmProviders[0].apiKey = 'clara-secret:v1:dW5kZWNyeXB0YWJsZQ==';
      disk.audioTranscription.apiKey = 'clara-secret:v1:YXVkaW8=';
      disk.modelManager.huggingFaceToken = 'clara-secret:v1:aGY=';
      disk.futureField = { arbitrary: ['retain', 42] };
      const configPath = join(tempDir, 'config.json');
      writeFileSync(configPath, JSON.stringify(disk), 'utf-8');
      expect((await loadTutorialProgress()).revision).toBe(0);
      await updateTutorialProgress({ action: 'start', expectedRevision: 0 });
      await updateTutorialProgress({ action: 'advance', expectedRevision: 1 });
      const stored = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
      const backup = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8')) as Record<string, any>;
      for (const document of [stored, backup]) {
        expect(document.llmProviders[0].apiKey).toBe(disk.llmProviders[0].apiKey);
        expect(document.audioTranscription.apiKey).toBe(disk.audioTranscription.apiKey);
        expect(document.modelManager.huggingFaceToken).toBe(disk.modelManager.huggingFaceToken);
        expect(document.futureField).toEqual(disk.futureField);
      }
      expect(stored.tutorial.active.stepId).toBe('home-start');
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('offers a newly registered phase after dismissing the shipped phases', () => {
    const dismissed = applyTutorialTransition(createDefaultConfig().tutorial!, { action: 'dismiss-all', expectedRevision: 0 });
    expect(dismissed.applied).toBe(true);
    const futureRegistry = [...TUTORIAL_PHASE_REGISTRY, { id: 'future-phase', steps: ['future-welcome'] }];
    const resumed = applyTutorialTransition(dismissed.progress, { action: 'start', expectedRevision: 1 }, futureRegistry);
    expect(resumed.progress.active).toEqual({ phaseId: 'future-phase', stepId: 'future-welcome' });
    expect(resumed.progress.phases.intro).toBe('dismissed');
  });

  it('persists the active step while preserving it across stale Settings and generic saves', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-config-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const stale = await loadConfig();
      expect((await updateTutorialProgress({ action: 'start', expectedRevision: 0 })).applied).toBe(true);
      expect((await updateTutorialProgress({ action: 'advance', expectedRevision: 1 })).applied).toBe(true);
      stale.chatFontSizeRem = 1.37;
      const merged = await updateConfig((disk) => mergeSettingsConfigSave(disk, stale));
      expect(merged.chatFontSizeRem).toBe(1.37);
      expect(merged.tutorial?.active).toEqual({ phaseId: 'intro', stepId: 'home-start' });
      await saveConfig(stale);
      const reloaded = await loadConfig();
      expect(reloaded.tutorial?.revision).toBe(2);
      expect(reloaded.tutorial?.active).toEqual({ phaseId: 'intro', stepId: 'home-start' });
      expect(JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8')).tutorial).toEqual(reloaded.tutorial);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes dismissal against stale starts and concurrent Settings saves', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-race-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const stale = await loadConfig();
      stale.chatFontSizeRem = 1.42;
      const [dismiss, resurrect] = await Promise.all([
        updateTutorialProgress({ action: 'dismiss-all', expectedRevision: 0 }),
        updateTutorialProgress({ action: 'start', expectedRevision: 0 }),
        updateConfig((disk) => mergeSettingsConfigSave(disk, stale)),
      ]);
      expect(dismiss.applied).toBe(true);
      expect(resurrect.applied).toBe(false);
      const final = await loadConfig();
      expect(final.chatFontSizeRem).toBe(1.42);
      expect(final.tutorial?.active).toBeNull();
      expect(final.tutorial?.revision).toBe(1);
      for (const phase of TUTORIAL_PHASE_REGISTRY) expect(final.tutorial?.phases[phase.id]).toBe('dismissed');
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes competing revisions across separate app processes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-multiprocess-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(sampleConfig()), 'utf8');
      const script = `
        const paths = require('./src/main/paths.ts');
        paths.getConfigPath = () => require('path').join(process.env.CLARA_TEST_CONFIG_DIR, 'config.json');
        const { updateTutorialProgress } = require('./src/main/config/load-save.ts');
        updateTutorialProgress({ action: process.argv[1], expectedRevision: 0 })
          .then((result) => console.log(JSON.stringify(result)))
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const launch = (action: string): Promise<{ applied: boolean }> => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, action], {
          cwd: process.cwd(), env: { ...process.env, CLARA_TEST_CONFIG_DIR: tempDir },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
          try { resolve(JSON.parse(stdout) as { applied: boolean }); } catch (error) { reject(error); }
        });
      });
      const lockPath = join(tempDir, 'config.json.lock');
      const deadOwner = { pid: 2147483647, token: 'old-process' };
      writeFileSync(lockPath, JSON.stringify(deadOwner), 'utf8');
      const key = createHash('sha256').update(JSON.stringify([deadOwner.pid, deadOwner.token])).digest('hex').slice(0, 32);
      const abandonedRecovery = `${lockPath}.recovery.${key}`;
      writeFileSync(abandonedRecovery, JSON.stringify({ pid: 2147483646, token: 'dead-reclaimer' }), 'utf8');
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);
      utimesSync(abandonedRecovery, old, old);
      const results = await Promise.all([
        launch('start'), launch('dismiss-all'), launch('start'), launch('dismiss-all'), launch('start'), launch('dismiss-all'),
      ]);
      expect(results.filter((result) => result.applied)).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8')).tutorial.revision).toBe(1);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('recovers an abandoned config lock without losing progress', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-stale-lock-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const lockPath = join(tempDir, 'config.json.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'abandoned' }), 'utf8');
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);
      expect((await updateTutorialProgress({ action: 'start', expectedRevision: 0 })).applied).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('restarts only a finished or dismissed tour, keeping what a newer release wrote', () => {
    const opaque = { status: 'future-resolution' };
    const finished = normalizeTutorialProgress({
      revision: 7,
      phases: { intro: 'completed', 'local-engine': 'skipped', 'featured-models': 'dismissed', 'local-source': opaque, 'future-phase': 'completed' },
      active: null,
      sourceId: 'old-source',
    });
    const restarted = applyTutorialTransition(finished, { action: 'restart', expectedRevision: 7 });
    expect(restarted.applied).toBe(true);
    expect(restarted.progress).toEqual({
      revision: 8, phases: { 'local-source': opaque, 'future-phase': 'completed' }, active: null,
    });

    const midway = normalizeTutorialProgress({ revision: 3, phases: { intro: 'completed' }, active: { phaseId: 'local-engine', stepId: 'engine-intro' } });
    expect(applyTutorialTransition(midway, { action: 'restart', expectedRevision: 3 }).applied).toBe(false);
    const offered = normalizeTutorialProgress({ revision: 3, phases: { intro: 'completed' }, active: null });
    expect(applyTutorialTransition(offered, { action: 'restart', expectedRevision: 3 }).applied).toBe(false);
    const future = normalizeTutorialProgress({
      revision: 3,
      phases: Object.fromEntries(TUTORIAL_PHASE_REGISTRY.map((phase) => [phase.id, 'completed'])),
      active: { phaseId: 'future-phase', stepId: 'future-step' },
    });
    expect(applyTutorialTransition(future, { action: 'restart', expectedRevision: 3 }).applied).toBe(false);
  });

  it('waits for a recent live lock owner but reclaims one that has long expired', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-recycled-pid-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const lockPath = join(tempDir, 'config.json.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live-holder' }), 'utf8');
      const recent = new Date(Date.now() - 10_000);
      utimesSync(lockPath, recent, recent);
      let settled = false;
      const waiting = updateTutorialProgress({ action: 'start', expectedRevision: 0 }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      rmSync(lockPath);
      expect((await waiting).applied).toBe(true);

      // A crashed owner's PID can be reused by an unrelated process, which then looks alive forever.
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'recycled-pid' }), 'utf8');
      const expired = new Date(Date.now() - 10 * 60_000);
      utimesSync(lockPath, expired, expired);
      expect((await updateTutorialProgress({ action: 'dismiss-all', expectedRevision: 1 })).applied).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('preserves opaque records on known phases and never schedules or clears their cursor', () => {
    const opaque = { status: 'future-resolution', details: ['retain'] };
    const progress = normalizeTutorialProgress({
      revision: 2, phases: { intro: opaque }, active: { phaseId: 'intro', stepId: 'welcome' },
    });
    expect(isTutorialPhaseResolved(opaque)).toBe(true);
    expect(isTutorialPhaseResolved(undefined)).toBe(false);
    expect(applyTutorialTransition(progress, { action: 'advance', expectedRevision: 2 }).applied).toBe(false);
    const dismissed = applyTutorialTransition(progress, { action: 'dismiss-all', expectedRevision: 2 });
    expect(dismissed.progress.phases.intro).toEqual(opaque);
    expect(dismissed.progress.active).toEqual(progress.active);
    expect(dismissed.progress.phases['local-engine']).toBe('dismissed');
    const futureCursor = { phaseId: 'intro', stepId: 'a-future-step' };
    expect(normalizeTutorialProgress({ revision: 3, phases: { intro: 'completed' }, active: futureCursor }).active)
      .toEqual(futureCursor);
  });

  it('advances and skips by stable registry IDs, then offers a newly added phase', () => {
    const registry = [{ id: 'first', steps: ['a', 'b'] }, { id: 'second', steps: ['c'] }];
    let progress = createDefaultConfig().tutorial!;
    for (const action of ['start', 'advance', 'advance', 'skip-phase'] as const) {
      const result = applyTutorialTransition(progress, { action, expectedRevision: progress.revision }, registry);
      expect(result.applied).toBe(true);
      progress = result.progress;
    }
    expect(progress.active).toBeNull();
    expect(progress.phases).toEqual({ first: 'completed', second: 'skipped' });
    const extended = [...registry, { id: 'later', steps: ['welcome-later'] }];
    expect(applyTutorialTransition(progress, { action: 'start', expectedRevision: 4 }, extended).progress.active)
      .toEqual({ phaseId: 'later', stepId: 'welcome-later' });
  });

  it('retains cursor extensions within a phase and clears the draft ID when entering a later phase', () => {
    const progress = {
      revision: 5,
      phases: {},
      active: { phaseId: 'local-source', stepId: 'sources-model', extension: { keep: true } },
      sourceId: 'draft-1',
    };
    const next = applyTutorialTransition(progress, { action: 'advance', expectedRevision: 5 });
    expect(next.progress.active).toEqual({ phaseId: 'local-source', stepId: 'sources-defaults', extension: { keep: true } });
    const registry = [{ id: 'local-source', steps: ['tour-complete'] }, { id: 'future', steps: ['start'] }];
    const finished = applyTutorialTransition({ ...progress, active: { phaseId: 'local-source', stepId: 'tour-complete' } },
      { action: 'advance', expectedRevision: 5 }, registry);
    expect(finished.progress.active?.phaseId).toBe('future');
    expect(finished.progress.sourceId).toBeUndefined();
  });

  it('preserves an unknown tutorial schema through transitions and ordinary saves', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-future-schema-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const future = { schemaVersion: 2, revision: 'future-revision', phases: ['new-layout'], active: { next: 7 }, extra: true };
      const disk = sampleConfig();
      disk.tutorial = future as never;
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify(disk), 'utf8');
      const stale = await loadConfig();
      expect(stale.tutorial).toEqual(future);
      expect((await updateTutorialProgress({ action: 'dismiss-all', expectedRevision: 0 })).applied).toBe(false);
      await updateConfig((cfg) => { cfg.chatFontSizeRem = 1.3; });
      await saveConfig(stale);
      expect(JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8')).tutorial).toEqual(future);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves the valid backup on both tutorial and ordinary recovery', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-backup-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const configPath = join(tempDir, 'config.json');
      const saved = JSON.parse(JSON.stringify(sampleConfig()));
      saved.llmProviders[0].apiKey = 'clara-secret:v1:dW5kZWNyeXB0YWJsZQ==';
      const valid = JSON.stringify(saved);
      writeFileSync(configPath, '{broken', 'utf8');
      writeFileSync(`${configPath}.bak`, valid, 'utf8');
      expect((await loadTutorialProgress()).revision).toBe(0);
      expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(valid);
      writeFileSync(configPath, '[]', 'utf8');
      expect((await loadConfig()).workspaces[0]?.id).toBe('ws-a');
      expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(valid);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).llmProviders[0].apiKey).toBe(saved.llmProviders[0].apiKey);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never creates defaults over an unreadable backup when the primary is missing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-bad-backup-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    try {
      const configPath = join(tempDir, 'config.json');
      writeFileSync(`${configPath}.bak`, '{broken', 'utf8');
      await expect(loadTutorialProgress()).rejects.toThrow('corrupt');
      await expect(loadConfig()).rejects.toThrow('corrupt');
      expect(() => loadConfigSync()).toThrow('corrupt');
      expect(existsSync(configPath)).toBe(false);
      expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('{broken');
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses private unique staging files, preserves the old primary on failure, and cleans up', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-atomic-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    const configPath = join(tempDir, 'config.json');
    try {
      await loadTutorialProgress();
      const original = readFileSync(configPath, 'utf8');
      writeFileSync(`${configPath}.tmp`, 'do not overwrite', 'utf8');
      const orphan = `${configPath}.11111111-1111-4111-8111-111111111111.tmp`;
      writeFileSync(orphan, 'interrupted private staging data', 'utf8');
      const rename = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === configPath) throw new Error('injected rename failure');
        return rename(from, to);
      });
      try {
        await expect(updateTutorialProgress({ action: 'start', expectedRevision: 0 })).rejects.toThrow('injected rename failure');
      } finally {
        spy.mockRestore();
      }
      expect(readFileSync(configPath, 'utf8')).toBe(original);
      expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(original);
      expect(readFileSync(`${configPath}.tmp`, 'utf8')).toBe('do not overwrite');
      expect(existsSync(orphan)).toBe(false);
      expect(readdirSync(tempDir).filter((name) => name.endsWith('.tmp'))).toEqual(['config.json.tmp']);
      expect((await updateTutorialProgress({ action: 'start', expectedRevision: 0 })).applied).toBe(true);
    } finally {
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('falls back to exclusive lock creation when hard links are unsupported', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clara-tutorial-no-hardlinks-'));
    process.env.CLARA_TEST_CONFIG_DIR = tempDir;
    const link = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    try {
      expect((await updateTutorialProgress({ action: 'start', expectedRevision: 0 })).applied).toBe(true);
      expect((await loadTutorialProgress()).active?.stepId).toBe('welcome');
      expect(existsSync(join(tempDir, 'config.json.lock'))).toBe(false);
    } finally {
      link.mockRestore();
      delete process.env.CLARA_TEST_CONFIG_DIR;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
