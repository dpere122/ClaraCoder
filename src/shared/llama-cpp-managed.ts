import type { LlamaCppManaged } from './types/app-config';

/** @internal Pre-2-command persisted shape; used only for one-time config migration. */
export interface LlamaCppEmbeddingManagedLegacy {
  enabled: boolean;
  loadKind: 'hf' | 'gguf';
  hfModel: string;
  ggufPath: string;
  pooling: string;
  ctxSize: number;
  nGpuLayers: number;
  host: string;
  extraArgs: string[];
}

/** @internal */
export interface LlamaCppManagedLegacy {
  serverExecutable: string;
  chat: {
    loadKind: 'hf' | 'gguf';
    hfModel: string;
    ggufPath: string;
    dev: string;
    tensorSplit: string;
    mainGpu: number;
    splitMode: string;
    ctxSize: number;
    nGpuLayers: number;
    host: string;
    extraArgs: string[];
  };
  embedding: LlamaCppEmbeddingManagedLegacy;
}

export type ShellQuotingPlatform = 'win32' | 'posix';

export function detectShellQuotingPlatform(): ShellQuotingPlatform {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc?.platform === 'win32') {
    return 'win32';
  }
  return 'posix';
}

/** One argv token safe for ``cmd.exe`` or POSIX shells when joined with spaces. */
export function shellQuoteArg(arg: string, platform: ShellQuotingPlatform): string {
  if (!/[\s"'`$\\|&;<>()%^]/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

export function argvToShellCommandLine(argv: string[], platform: ShellQuotingPlatform): string {
  return argv.map((a) => shellQuoteArg(a, platform)).join(' ');
}

export function defaultLlamaCppManaged(): LlamaCppManaged {
  return {
    chatRunCommand: '',
    embeddingRunCommand: '',
  };
}

const PORT_TOKEN = '{{PORT}}';
/** Baseline managed chat command template used in defaults and Settings placeholders. */
export const DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND =
  'llama-server --host 127.0.0.1 --port {{PORT}} --jinja --no-webui -np 1 -hf org/model:Q4_0';

/** True when a managed chat command already includes ``--jinja``. */
export function managedLlamaCommandHasJinja(command: string): boolean {
  // ``\b`` is unreliable before ``--`` (hyphen is not ``\w``), so match long options as tokens.
  return /(?:^|[\s"'])--jinja(?:\s|$)/i.test(command);
}

/**
 * Append ``--jinja`` for managed ``llama-server`` when the command does not already have it.
 * Does not rewrite saved Settings text; callers apply this at generate/start time.
 */
export function appendJinjaFlagToManagedChatCommand(chatRunCommand: string): string {
  const cmd = chatRunCommand.trim();
  if (!cmd || managedLlamaCommandHasJinja(cmd)) {
    return chatRunCommand;
  }
  return `${cmd} --jinja`;
}

/**
 * True when persisted JSON still uses nested chat/embedding (or executable-only) managed blocks.
 */
export function isLegacyLlamaCppManagedShape(lm: unknown): boolean {
  if (!lm || typeof lm !== 'object') {
    return false;
  }
  const o = lm as Record<string, unknown>;
  const hasNewCommands =
    typeof o['chatRunCommand'] === 'string' && typeof o['embeddingRunCommand'] === 'string';
  if (hasNewCommands) {
    return false;
  }
  if (typeof o['chat'] === 'object' && o['chat'] !== null) {
    return true;
  }
  if (typeof o['serverExecutable'] === 'string' && typeof o['chatRunCommand'] !== 'string') {
    return true;
  }
  return false;
}

function defaultLegacyEmbedding(): LlamaCppEmbeddingManagedLegacy {
  return {
    enabled: false,
    loadKind: 'gguf',
    hfModel: '',
    ggufPath: '',
    pooling: 'mean',
    ctxSize: 8192,
    nGpuLayers: 99,
    host: '127.0.0.1',
    extraArgs: [],
  };
}

function defaultLegacyManaged(): LlamaCppManagedLegacy {
  return {
    serverExecutable: 'llama-server',
    chat: {
      loadKind: 'hf',
      hfModel: '',
      ggufPath: '',
      dev: '',
      tensorSplit: '',
      mainGpu: 0,
      splitMode: 'layer',
      ctxSize: 16384,
      nGpuLayers: 0,
      host: '127.0.0.1',
      extraArgs: [],
    },
    embedding: defaultLegacyEmbedding(),
  };
}

function coerceLegacyManaged(raw: Record<string, unknown>): LlamaCppManagedLegacy {
  const base = defaultLegacyManaged();
  const se = raw['serverExecutable'];
  const exe =
    typeof se === 'string' && se.trim()
      ? se.trim()
      : base.serverExecutable;
  const chIn = raw['chat'];
  const ch =
    chIn && typeof chIn === 'object' && chIn !== null ? (chIn as Record<string, unknown>) : {};
  const loadKind: 'hf' | 'gguf' = ch['loadKind'] === 'gguf' ? 'gguf' : 'hf';
  const chat = {
    ...base.chat,
    loadKind,
    hfModel: typeof ch['hfModel'] === 'string' ? ch['hfModel'] : base.chat.hfModel,
    ggufPath: typeof ch['ggufPath'] === 'string' ? ch['ggufPath'] : base.chat.ggufPath,
    dev: typeof ch['dev'] === 'string' ? ch['dev'] : base.chat.dev,
    tensorSplit: typeof ch['tensorSplit'] === 'string' ? ch['tensorSplit'] : base.chat.tensorSplit,
    mainGpu:
      typeof ch['mainGpu'] === 'number' && !Number.isNaN(ch['mainGpu'])
        ? Math.max(0, Math.floor(ch['mainGpu'] as number))
        : base.chat.mainGpu,
    splitMode: typeof ch['splitMode'] === 'string' ? ch['splitMode'] : base.chat.splitMode,
    ctxSize:
      typeof ch['ctxSize'] === 'number' && !Number.isNaN(ch['ctxSize'])
        ? Math.min(10_000_000, Math.max(256, Math.floor(ch['ctxSize'] as number)))
        : base.chat.ctxSize,
    nGpuLayers:
      typeof ch['nGpuLayers'] === 'number' && !Number.isNaN(ch['nGpuLayers'])
        ? Math.max(0, Math.floor(ch['nGpuLayers'] as number))
        : base.chat.nGpuLayers,
    host:
      typeof ch['host'] === 'string' && (ch['host'] as string).trim()
        ? (ch['host'] as string)
        : base.chat.host,
    extraArgs: Array.isArray(ch['extraArgs'])
      ? (ch['extraArgs'] as unknown[]).map((x) => String(x))
      : base.chat.extraArgs,
  };

  const emIn = raw['embedding'];
  const em =
    emIn && typeof emIn === 'object' && emIn !== null ? (emIn as Record<string, unknown>) : {};
  const eb = defaultLegacyEmbedding();
  const emLoadKind: 'hf' | 'gguf' = em['loadKind'] === 'hf' ? 'hf' : 'gguf';
  const embedding: LlamaCppEmbeddingManagedLegacy = {
    enabled: em['enabled'] === true,
    loadKind: emLoadKind,
    hfModel: typeof em['hfModel'] === 'string' ? em['hfModel'] : eb.hfModel,
    ggufPath: typeof em['ggufPath'] === 'string' ? em['ggufPath'] : eb.ggufPath,
    pooling:
      typeof em['pooling'] === 'string' && (em['pooling'] as string).trim()
        ? (em['pooling'] as string)
        : eb.pooling,
    ctxSize:
      typeof em['ctxSize'] === 'number' && !Number.isNaN(em['ctxSize'])
        ? Math.min(10_000_000, Math.max(256, Math.floor(em['ctxSize'] as number)))
        : eb.ctxSize,
    nGpuLayers:
      typeof em['nGpuLayers'] === 'number' && !Number.isNaN(em['nGpuLayers'])
        ? Math.max(0, Math.floor(em['nGpuLayers'] as number))
        : eb.nGpuLayers,
    host:
      typeof em['host'] === 'string' && (em['host'] as string).trim()
        ? (em['host'] as string)
        : eb.host,
    extraArgs: Array.isArray(em['extraArgs'])
      ? (em['extraArgs'] as unknown[]).map((x) => String(x))
      : eb.extraArgs,
  };

  return { serverExecutable: exe, chat, embedding };
}

/**
 * Build argv for one legacy llama-server invocation (chat or embedding). Use ``port: 'template'`` to emit ``{{PORT}}``.
 */
export function buildLlamaServerArgv(
  kind: 'chat' | 'embedding',
  managed: LlamaCppManagedLegacy,
  port: number | 'template',
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const portStr = port === 'template' ? PORT_TOKEN : String(port);

  if (kind === 'embedding') {
    const emb = managed.embedding;
    if (!emb.enabled) {
      return { ok: false, error: 'Embedding block is disabled.' };
    }
    const argv: string[] = [];
    const loadKind = emb.loadKind === 'hf' ? 'hf' : 'gguf';
    if (loadKind === 'hf') {
      const hf = (emb.hfModel || '').trim();
      if (!hf) {
        return { ok: false, error: 'Embedding Hugging Face model id (-hf) is required when load kind is hf.' };
      }
      argv.push('-hf', hf);
    } else {
      const path = (emb.ggufPath || '').trim();
      if (!path) {
        return { ok: false, error: 'Embedding GGUF path (-m) is required when load kind is gguf.' };
      }
      argv.push('-m', path);
    }
    argv.push(
      '--embedding',
      '--pooling',
      (emb.pooling || 'mean').trim() || 'mean',
      '-c',
      String(Math.max(256, emb.ctxSize || 8192)),
      // llama-server defaults n_ubatch to 512; embedding one sequence longer than that returns HTTP 500.
      '-b',
      '2048',
      '-ub',
      '2048',
      '--host',
      (emb.host || '127.0.0.1').trim() || '127.0.0.1',
      '--port',
      portStr,
    );
    if (emb.nGpuLayers > 0) {
      argv.push('-ngl', String(emb.nGpuLayers));
    }
    for (const x of emb.extraArgs || []) {
      const t = String(x).trim();
      if (t) argv.push(t);
    }
    return { ok: true, argv };
  }

  const c = managed.chat;
  const argv: string[] = [];

  const dev = (c.dev || '').trim();
  if (dev) {
    argv.push('-dev', dev);
  }

  const ts = (c.tensorSplit || '').trim();
  if (ts) {
    argv.push('--tensor-split', ts);
  }

  argv.push('--main-gpu', String(Math.max(0, c.mainGpu ?? 0)));

  const sm = (c.splitMode || '').trim();
  if (sm) {
    argv.push('--split-mode', sm);
  }

  argv.push('-c', String(Math.max(256, c.ctxSize || 4096)));

  argv.push('--host', (c.host || '127.0.0.1').trim() || '127.0.0.1', '--port', portStr, '--jinja');

  if (c.loadKind === 'hf') {
    const hf = (c.hfModel || '').trim();
    if (!hf) {
      return { ok: false, error: 'Hugging Face model id (-hf) is required for chat when load kind is hf.' };
    }
    argv.push('-hf', hf);
  } else {
    const gp = (c.ggufPath || '').trim();
    if (!gp) {
      return { ok: false, error: 'GGUF path (-m) is required for chat when load kind is gguf.' };
    }
    argv.push('-m', gp);
  }

  if (c.nGpuLayers > 0) {
    argv.push('-ngl', String(c.nGpuLayers));
  }

  for (const x of c.extraArgs || []) {
    const t = String(x).trim();
    if (t) argv.push(t);
  }

  return { ok: true, argv };
}

/**
 * Convert a legacy nested managed profile into ``chatRunCommand`` / ``embeddingRunCommand``.
 * On argv build failure, returns empty strings for the failed side so the user can fix commands in Settings.
 */
export function migrateLegacyLlamaCppManagedToCommands(
  raw: Record<string, unknown>,
  platform: ShellQuotingPlatform,
): LlamaCppManaged {
  const legacy = coerceLegacyManaged(raw);
  const exe = legacy.serverExecutable || 'llama-server';

  let chatRunCommand = '';
  const chatBuilt = buildLlamaServerArgv('chat', legacy, 'template');
  if (chatBuilt.ok) {
    chatRunCommand = argvToShellCommandLine([exe, ...chatBuilt.argv], platform);
  }

  let embeddingRunCommand = '';
  if (legacy.embedding.enabled) {
    const embBuilt = buildLlamaServerArgv('embedding', legacy, 'template');
    if (embBuilt.ok) {
      embeddingRunCommand = argvToShellCommandLine([exe, ...embBuilt.argv], platform);
    }
  }

  return { chatRunCommand, embeddingRunCommand };
}

/** Parse ``--host`` from a substituted command line (first occurrence). */
export function parseHostFromLlamaCommand(command: string): string {
  const m = /--host\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const h = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
  return h || '127.0.0.1';
}

function unquoteChatTemplatePath(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const CHAT_TEMPLATE_FILE_RE =
  /(?:^|[\s"'])--chat-template-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const CHAT_TEMPLATE_FILE_REPLACE_RE =
  /(^|[\s"'])(--chat-template-file(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+))/i;
const CHAT_TEMPLATE_FILE_STRIP_RE =
  /\s*--chat-template-file(?:\s+|=)(?:"[^"]+"|'[^']+'|\S+)/gi;

/** Parse ``--chat-template-file`` from a managed chat command. Empty / absent → ``null`` (use GGUF). */
export function parseManagedLlamaChatTemplateFile(cmd: string): string | null {
  const t = (cmd || '').trim();
  if (!t) {
    return null;
  }
  const m = CHAT_TEMPLATE_FILE_RE.exec(t);
  if (!m) {
    return null;
  }
  const filePath = unquoteChatTemplatePath(m[1] ?? m[2] ?? m[3] ?? '');
  return filePath || null;
}

/**
 * Set or strip ``--chat-template-file`` on a managed chat command.
 * ``null`` / empty path removes the flag (GGUF template). Paths with spaces are quoted.
 */
export function syncChatTemplateFileInManagedChatCommand(
  cmd: string,
  templatePath: string | null,
  platform: ShellQuotingPlatform = detectShellQuotingPlatform(),
): string {
  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const filePath = (templatePath || '').trim();
  if (!filePath) {
    CHAT_TEMPLATE_FILE_STRIP_RE.lastIndex = 0;
    return trimmed.replace(CHAT_TEMPLATE_FILE_STRIP_RE, '').replace(/\s{2,}/g, ' ').trim();
  }
  const quoted = shellQuoteArg(filePath, platform);
  const replaced = trimmed.replace(
    CHAT_TEMPLATE_FILE_REPLACE_RE,
    (_full, lead: string) => `${lead}--chat-template-file ${quoted}`,
  );
  if (replaced !== trimmed) {
    return replaced;
  }
  return `${trimmed} --chat-template-file ${quoted}`;
}

/**
 * Append ``--jinja`` and ``--chat-template-file`` for managed ``llama-server``.
 * Skips the file flag if the user command already contains ``--chat-template-file``.
 * ``--jinja`` is still ensured (managed llama-server always defaults it).
 */
export function appendChatTemplateFileFlags(
  chatRunCommand: string,
  templatePath: string,
  platform: ShellQuotingPlatform,
): string {
  const cmd = chatRunCommand.trim();
  // ``\b`` is unreliable before ``--`` (hyphen is not ``\w``), so match long options as tokens.
  if (/(?:^|[\s"'])--chat-template-file(?:\s|=|$)/i.test(cmd)) {
    return appendJinjaFlagToManagedChatCommand(chatRunCommand);
  }
  const quoted = shellQuoteArg(templatePath, platform);
  const tail = managedLlamaCommandHasJinja(cmd)
    ? `--chat-template-file ${quoted}`
    : `--jinja --chat-template-file ${quoted}`;
  return `${cmd} ${tail}`;
}

/** @deprecated Use :func:`appendChatTemplateFileFlags`. */
export function appendQwenChatTemplateFlagsToManagedChatCommand(
  chatRunCommand: string,
  templatePath: string,
  platform: ShellQuotingPlatform,
): string {
  return appendChatTemplateFileFlags(chatRunCommand, templatePath, platform);
}

/**
 * Validate and substitute ``{{PORT}}`` for one managed server command before argv spawn (no shell).
 */
export function prepareManagedLlamaShellCommand(
  raw: string,
  port: number,
): { ok: true; command: string; host: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Run command is empty.' };
  }
  const matches = trimmed.split(PORT_TOKEN).length - 1;
  if (matches === 0) {
    return { ok: false, error: `Run command must contain exactly one ${PORT_TOKEN} placeholder.` };
  }
  if (matches !== 1) {
    return { ok: false, error: `Run command must contain exactly one ${PORT_TOKEN} placeholder (found ${matches}).` };
  }
  const command = trimmed.replace(PORT_TOKEN, String(port));
  if (command.includes(PORT_TOKEN)) {
    return { ok: false, error: `Run command must contain exactly one ${PORT_TOKEN} placeholder.` };
  }
  return { ok: true, command, host: parseHostFromLlamaCommand(command) };
}
