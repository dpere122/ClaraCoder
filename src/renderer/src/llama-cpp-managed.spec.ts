import {
  argvToShellCommandLine,
  buildLlamaServerArgv,
  defaultLlamaCppManaged,
  isLegacyLlamaCppManagedShape,
  migrateLegacyLlamaCppManagedToCommands,
  parseHostFromLlamaCommand,
  prepareManagedLlamaShellCommand,
  type LlamaCppManagedLegacy,
} from '@shared/index';

describe('defaultLlamaCppManaged', () => {
  it('provides empty run commands', () => {
    const d = defaultLlamaCppManaged();
    expect(d.chatRunCommand).toBe('');
    expect(d.embeddingRunCommand).toBe('');
  });
});

describe('prepareManagedLlamaShellCommand', () => {
  it('substitutes port and parses host', () => {
    const r = prepareManagedLlamaShellCommand('llama-server --host 0.0.0.0 --port {{PORT}} -m x.gguf', 5555);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command).toContain('5555');
    expect(r.command).not.toContain('{{PORT}}');
    expect(r.host).toBe('0.0.0.0');
  });

  it('defaults host to 127.0.0.1', () => {
    const r = prepareManagedLlamaShellCommand('llama-server --port {{PORT}} -m x.gguf', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.host).toBe('127.0.0.1');
  });

  it('parses double-quoted host', () => {
    const r = prepareManagedLlamaShellCommand('llama-server --host "10.0.0.1" --port {{PORT}} -m m', 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.host).toBe('10.0.0.1');
  });

  it('errors on empty command', () => {
    const r = prepareManagedLlamaShellCommand('   ', 1);
    expect(r.ok).toBe(false);
  });

  it('errors when placeholder missing', () => {
    const r = prepareManagedLlamaShellCommand('llama-server --port 8080', 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/PORT/);
  });

  it('errors when placeholder appears twice', () => {
    const r = prepareManagedLlamaShellCommand('llama-server --port {{PORT}} --x {{PORT}}', 1);
    expect(r.ok).toBe(false);
  });
});

describe('parseHostFromLlamaCommand', () => {
  it('returns 127.0.0.1 when absent', () => {
    expect(parseHostFromLlamaCommand('llama-server -m a')).toBe('127.0.0.1');
  });
});

describe('isLegacyLlamaCppManagedShape', () => {
  it('detects nested chat object', () => {
    expect(isLegacyLlamaCppManagedShape({ chat: { loadKind: 'hf' }, embedding: {} })).toBe(true);
  });

  it('detects serverExecutable without chatRunCommand', () => {
    expect(isLegacyLlamaCppManagedShape({ serverExecutable: 'llama-server' })).toBe(true);
  });

  it('is false for new shape', () => {
    expect(isLegacyLlamaCppManagedShape({ chatRunCommand: 'x {{PORT}}', embeddingRunCommand: '' })).toBe(false);
  });

  it('is false when new commands exist even if a stale chat key remains', () => {
    expect(
      isLegacyLlamaCppManagedShape({
        chatRunCommand: 'llama-server --port {{PORT}} -m a.gguf',
        embeddingRunCommand: '',
        chat: { loadKind: 'hf' },
      }),
    ).toBe(false);
  });
});

describe('migrateLegacyLlamaCppManagedToCommands', () => {
  it('migrates chat hf and disabled embedding', () => {
    const legacy: LlamaCppManagedLegacy = {
      serverExecutable: 'llama-server',
      chat: {
        loadKind: 'hf',
        hfModel: 'org/model:Q4',
        ggufPath: '',
        dev: '',
        tensorSplit: '',
        mainGpu: 0,
        splitMode: 'layer',
        ctxSize: 4096,
        nGpuLayers: 0,
        host: '127.0.0.1',
        extraArgs: [],
      },
      embedding: {
        enabled: false,
        loadKind: 'gguf',
        hfModel: '',
        ggufPath: '',
        pooling: 'mean',
        ctxSize: 8192,
        nGpuLayers: 0,
        host: '127.0.0.1',
        extraArgs: [],
      },
    };
    const m = migrateLegacyLlamaCppManagedToCommands(legacy as unknown as Record<string, unknown>, 'posix');
    expect(m.embeddingRunCommand).toBe('');
    expect(m.chatRunCommand).toContain('llama-server');
    expect(m.chatRunCommand).toContain('{{PORT}}');
    expect(m.chatRunCommand).toContain('-hf');
    expect(m.chatRunCommand).toContain('org/model:Q4');
  });

  it('migrates embedding when enabled', () => {
    const legacy: LlamaCppManagedLegacy = {
      serverExecutable: 'C:\\\\bin\\\\llama-server.exe',
      chat: {
        loadKind: 'gguf',
        hfModel: '',
        ggufPath: 'C:\\\\a b\\\\m.gguf',
        dev: '',
        tensorSplit: '',
        mainGpu: 0,
        splitMode: '',
        ctxSize: 2048,
        nGpuLayers: 0,
        host: '127.0.0.1',
        extraArgs: [],
      },
      embedding: {
        enabled: true,
        loadKind: 'gguf',
        hfModel: '',
        ggufPath: 'e.gguf',
        pooling: 'mean',
        ctxSize: 8192,
        nGpuLayers: 99,
        host: '127.0.0.1',
        extraArgs: [],
      },
    };
    const m = migrateLegacyLlamaCppManagedToCommands(legacy as unknown as Record<string, unknown>, 'win32');
    expect(m.embeddingRunCommand).toContain('{{PORT}}');
    expect(m.embeddingRunCommand).toContain('--embedding');
    expect(m.chatRunCommand).toContain('m.gguf');
  });
});

describe('buildLlamaServerArgv (legacy migration)', () => {
  it('emits template port token', () => {
    const managed: LlamaCppManagedLegacy = {
      serverExecutable: 'llama-server',
      chat: {
        loadKind: 'hf',
        hfModel: 'x/y:z',
        ggufPath: '',
        dev: 'Vulkan0',
        tensorSplit: '',
        mainGpu: 0,
        splitMode: '',
        ctxSize: 4096,
        nGpuLayers: 0,
        host: '127.0.0.1',
        extraArgs: [],
      },
      embedding: {
        enabled: false,
        loadKind: 'gguf',
        hfModel: '',
        ggufPath: '',
        pooling: 'mean',
        ctxSize: 8192,
        nGpuLayers: 0,
        host: '127.0.0.1',
        extraArgs: [],
      },
    };
    const r = buildLlamaServerArgv('chat', managed, 'template');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.argv).toContain('{{PORT}}');
  });
});

describe('argvToShellCommandLine', () => {
  it('quotes args with spaces on posix', () => {
    const line = argvToShellCommandLine(['llama-server', '-m', '/a b/c.gguf'], 'posix');
    expect(line).toContain(`'/a b/c.gguf'`);
  });
});
