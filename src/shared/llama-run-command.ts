/**
 * What a managed ``llama-server`` run command actually does: which flags the server uses, which it
 * ignores, and what Clara changes at start. Shared by the Settings editor and the launch path, so
 * the preview and the spawned command cannot drift.
 */
import {
  isLlamaFlagToken,
  parseLlamaFlagOccurrences,
  scanLlamaCommandTokens,
  shellQuoteArg,
  spliceOutLlamaSpans,
  tokenizeManagedLlamaCommand,
  type LlamaFlagOccurrence,
  type ShellQuotingPlatform,
} from './llama-command-tokens';
import { appendJinjaFlagToManagedChatCommand } from './llama-cpp-managed';
import {
  ensureManagedLlamaDefaultServerFlags,
  ensureManagedLlamaGemmaReasoningFormat,
  promoteManagedSentinelNglToAuto,
} from './managed-llama-model-pick';

const PORT_TOKEN = '{{PORT}}';

/** One option from ``llama-server --help``. */
export interface LlamaFlagSpec {
  /** Every spelling, including ``--no-x`` negations. */
  names: string[];
  /** Value placeholder from the help text; ``null`` for a flag that takes no value. */
  valueHint: string | null;
  /** Allowed values when the help text enumerates them. */
  choices: string[] | null;
  description: string;
  defaultValue: string | null;
  section: string;
}

export interface LlamaFlagCatalog {
  /** Build line from ``llama-server --version`` when known. */
  version: string | null;
  flags: LlamaFlagSpec[];
}

function parseHelpHead(line: string): { names: string[]; valueHint: string | null; rest: string } {
  const names: string[] = [];
  let i = 0;
  for (;;) {
    const m = /^(-[^\s,]+)(,\s*)?/.exec(line.slice(i));
    if (!m) {
      break;
    }
    names.push(m[1] as string);
    i += m[0].length;
    if (!m[2]) {
      break;
    }
  }
  const tail = line.slice(i);
  const gap = /^\s*/.exec(tail)?.[0].length ?? 0;
  const body = tail.slice(gap);
  // One space means a value placeholder follows; a padded gap is the start of the description.
  if (!body || gap !== 1) {
    return { names, valueHint: null, rest: body };
  }
  const split = /\s{2,}/.exec(body);
  return split
    ? { names, valueHint: body.slice(0, split.index), rest: body.slice(split.index + split[0].length) }
    : { names, valueHint: body, rest: '' };
}

function choicesFromHint(hint: string | null, description: string): string[] | null {
  const allowed = /allowed values:\s*([^()]+?)(?:\s*\(|$)/i.exec(description);
  if (allowed) {
    const values = (allowed[1] as string).split(/,\s*/).map((v) => v.trim()).filter(Boolean);
    return values.length > 1 ? values : null;
  }
  if (!hint) {
    return null;
  }
  const wrapped = /^[{[<](.*)[}\]>]$/.exec(hint);
  const body = wrapped ? (wrapped[1] as string) : hint;
  const bare = /^[a-z0-9][a-z0-9_-]*(?:[|,][a-z0-9][a-z0-9_-]*)+$/;
  if (!bare.test(body) || (!wrapped && /\|/.test(body))) {
    return null;
  }
  // ``<dev1,dev2,..>``-style placeholders fail the pattern; ``<a,b>`` lists are values, not choices.
  if (hint.startsWith('<') && body.includes(',')) {
    return null;
  }
  return body.split(/[|,]/);
}

/** Parse the option table printed by ``llama-server --help``. */
export function parseLlamaServerHelp(helpText: string, version: string | null = null): LlamaFlagCatalog {
  const flags: LlamaFlagSpec[] = [];
  let section = '';
  let current: { head: ReturnType<typeof parseHelpHead>; lines: string[]; section: string } | null = null;
  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = current.lines.map((l) => l.trim()).filter(Boolean);
    const joined = text.filter((l) => !/^\(env:/.test(l)).join(' ');
    const description = joined.replace(/\[\(?more\s+info\)?\]\([^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
    flags.push({
      names: current.head.names,
      valueHint: current.head.valueHint,
      choices: choicesFromHint(current.head.valueHint, description),
      description,
      defaultValue: /\(default:\s*([^)]*)\)/.exec(description)?.[1]?.trim() ?? null,
      section: current.section,
    });
    current = null;
  };
  for (const raw of (helpText || '').split(/\r?\n/)) {
    const heading = /^-{3,}\s*(.+?)\s*-{3,}$/.exec(raw.trim());
    if (heading) {
      flush();
      section = heading[1] as string;
      continue;
    }
    if (raw.startsWith('-')) {
      flush();
      const head = parseHelpHead(raw);
      if (head.names.length) {
        current = { head, lines: head.rest ? [head.rest] : [], section };
      }
      continue;
    }
    if (!raw.trim()) {
      continue;
    }
    if (/^\s/.test(raw)) {
      current?.lines.push(raw);
    } else {
      flush();
    }
  }
  flush();
  return { version, flags };
}

/** Index a catalog by every flag name. */
function catalogIndex(catalog: LlamaFlagCatalog | null): Map<string, LlamaFlagSpec> {
  const index = new Map<string, LlamaFlagSpec>();
  for (const spec of catalog?.flags ?? []) {
    for (const name of spec.names) {
      index.set(name, spec);
    }
  }
  return index;
}

/** Alias groups Clara must recognize even before the installed server has been asked. */
const CORE_FLAG_GROUPS: readonly (readonly string[])[] = [
  ['-m', '--model'],
  ['-hf', '-hfr', '--hf-repo'],
  ['-mm', '--mmproj'],
  ['-c', '--ctx-size'],
  ['-b', '--batch-size'],
  ['-ub', '--ubatch-size'],
  ['-fa', '--flash-attn'],
  ['-ctk', '--cache-type-k'],
  ['-ctv', '--cache-type-v'],
  ['-ngl', '--gpu-layers', '--n-gpu-layers'],
  ['-dev', '--device'],
  ['-ts', '--tensor-split'],
  ['-mg', '--main-gpu'],
  ['-np', '--parallel'],
  ['-cram', '--cache-ram'],
  ['--jinja', '--no-jinja'],
  ['--ui', '--webui', '--no-ui', '--no-webui'],
  ['--mmproj-auto', '--no-mmproj', '--no-mmproj-auto'],
  ['-n', '--predict', '--n-predict'],
  ['--temp', '--temperature'],
];

function flagGroupNames(name: string, spec: LlamaFlagSpec | null): readonly string[] {
  return spec?.names ?? CORE_FLAG_GROUPS.find((group) => group.includes(name)) ?? [name];
}

/** Stable identity for "the same option", whichever alias was written. */
function flagKey(name: string, spec: LlamaFlagSpec | null): string {
  return [...flagGroupNames(name, spec)].sort()[0] as string;
}

export type LlamaFlagStatus =
  /** The server uses this value. */
  | 'used'
  /** A later occurrence, or a flag Clara appends at start, replaces it. */
  | 'overridden'
  /** Clara sends this setting per request, so the command value is only a fallback. */
  | 'request'
  /** Accepted by the server, but nothing else in the command makes it matter. */
  | 'no-effect'
  /** Clara changes this value at start. */
  | 'rewritten'
  /** Clara owns the value (the port). */
  | 'managed'
  /** The server refuses to start with this as written. */
  | 'invalid'
  /** The installed server does not list this flag. */
  | 'unknown';

export interface LlamaCommandEntry {
  /** Stable across value edits: option identity plus occurrence number. */
  id: string;
  flag: string;
  /** Long name to show alongside a short alias, when there is one. */
  longName: string | null;
  value: string | null;
  takesValue: boolean;
  start: number;
  end: number;
  inline: boolean;
  spec: LlamaFlagSpec | null;
  status: LlamaFlagStatus;
  note: string;
}

export interface LlamaAddedFlag {
  flag: string;
  value: string | null;
  note: string;
}

export interface LlamaCommandAnalysis {
  /** Problems that stop the server from starting. */
  errors: string[];
  /** Problems that let it start but probably not as intended. */
  warnings: string[];
  entries: LlamaCommandEntry[];
  addedAtStart: LlamaAddedFlag[];
  /** The command Clara spawns, with ``{{PORT}}`` still in place. */
  startCommand: string;
  /** True when flags were checked against the installed server. */
  verified: boolean;
}

export interface LlamaAnalyzeOptions {
  catalog?: LlamaFlagCatalog | null;
  /** Flags that Clara's per-request settings replace, with the setting's label. */
  requestOverrides?: readonly { names: readonly string[]; label: string }[];
  optimizationPreset?: string;
  platform: ShellQuotingPlatform;
}

/**
 * Flags Clara appends to a chat command at start, when missing: ``--jinja``, the server defaults,
 * and the Gemma reasoning format. Expects the binary already resolved.
 */
function appendManagedStartFlags(command: string, optimizationPreset: string | undefined): string {
  let out = ensureManagedLlamaDefaultServerFlags(appendJinjaFlagToManagedChatCommand(command));
  if ((optimizationPreset || '').trim().toLowerCase() === 'gemma') {
    out = ensureManagedLlamaGemmaReasoningFormat(out);
  }
  return out;
}

/** The command Clara spawns for a saved chat command, before ``{{PORT}}`` is filled in. */
export function buildManagedChatStartCommand(
  command: string,
  optimizationPreset: string | undefined,
  platform: ShellQuotingPlatform,
): string {
  return appendManagedStartFlags(promoteManagedSentinelNglToAuto(command, platform), optimizationPreset);
}

const ADDED_FLAG_NOTES: Readonly<Record<string, string>> = {
  '--jinja': 'Clara needs the model chat template.',
  '--no-webui': 'Clara is the UI, so the server skips its own.',
  '-np': 'One slot for Clara’s one conversation at a time.',
  '--cache-ram': 'Stops the host-RAM prompt cache growing over long sessions.',
  '--reasoning-format': 'Lets Clara split Gemma thinking while it streams.',
};

/** Arity from the catalog when it has the flag; otherwise decided from the next token. */
function arityFrom(index: Map<string, LlamaFlagSpec>): (name: string) => boolean | undefined {
  return (name) => {
    const spec = index.get(name);
    return spec ? spec.valueHint !== null : undefined;
  };
}

const SPECULATIVE_TUNING_RE = /^--(?:spec-draft-n-|spec-draft-p-|spec-ngram-)/;
const DRAFT_MODEL_NAMES = ['-md', '--model-draft', '--spec-draft-model', '-hfd', '-hfrd', '--spec-draft-hf', '--hf-repo-draft'];
const QUANTIZED_CACHE_RE = /^(?:q\d|iq\d)/i;

interface ClassifyContext {
  entries: LlamaCommandEntry[];
  value(names: readonly string[]): string | null;
  has(names: readonly string[]): boolean;
}

/** Interactions that make an accepted flag do nothing, or do less than it says. */
function interactionNote(entry: LlamaCommandEntry, ctx: ClassifyContext): string {
  const names = flagGroupNames(entry.flag, entry.spec);
  if (names.includes('--mmproj') && ctx.has(['--no-mmproj', '--no-mmproj-auto'])) {
    return '--no-mmproj is also set, so no projector is loaded.';
  }
  if (names.includes('--ubatch-size')) {
    const batch = Number.parseInt(ctx.value(['-b', '--batch-size']) ?? '2048', 10);
    const ubatch = Number.parseInt(entry.value ?? '', 10);
    if (Number.isFinite(batch) && Number.isFinite(ubatch) && ubatch > batch) {
      return `Larger than the batch size, so llama.cpp uses ${batch}.`;
    }
  }
  const speculative = ctx.value(['--spec-type']);
  if (
    names.some((name) => SPECULATIVE_TUNING_RE.test(name)) &&
    (!speculative || speculative === 'none') &&
    !ctx.has(DRAFT_MODEL_NAMES)
  ) {
    return 'Speculative decoding is off (no --spec-type), so this does nothing.';
  }
  return '';
}

/** Parse a command into entries, each with what the server does with it. */
export function analyzeLlamaRunCommand(command: string, options: LlamaAnalyzeOptions): LlamaCommandAnalysis {
  const { catalog = null, requestOverrides = [], optimizationPreset, platform } = options;
  const trimmed = (command || '').trim();
  const verified = !!catalog?.flags.length;
  const index = catalogIndex(catalog);
  const arity = arityFrom(index);
  const startCommand = trimmed ? buildManagedChatStartCommand(trimmed, optimizationPreset, platform) : '';
  const promoted = trimmed ? promoteManagedSentinelNglToAuto(trimmed, platform) : '';
  const appended = startCommand.slice(promoted.length);
  const addedOccurrences = appended ? parseLlamaFlagOccurrences(`x ${appended}`, arity) : [];

  const occurrences = parseLlamaFlagOccurrences(trimmed, arity);
  const lastByKey = new Map<string, number>();
  occurrences.forEach((occ, i) => lastByKey.set(flagKey(occ.name, index.get(occ.name) ?? null), i));
  const addedKeys = new Set(addedOccurrences.map((occ) => flagKey(occ.name, index.get(occ.name) ?? null)));

  const seen = new Map<string, number>();
  const entries: LlamaCommandEntry[] = occurrences.map((occ, i) => {
    const spec = index.get(occ.name) ?? null;
    const key = flagKey(occ.name, spec);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const longName = occ.written.startsWith('--')
      ? null
      : (flagGroupNames(occ.name, spec).find((n) => n.startsWith('--') && !n.startsWith('--no-')) ?? null);
    const takesValue = spec ? spec.valueHint !== null : occ.value !== null;
    const entry: LlamaCommandEntry = {
      id: `${key}#${nth}`,
      flag: occ.written,
      longName,
      value: occ.value,
      takesValue,
      start: occ.start,
      end: occ.end,
      inline: occ.inline,
      spec,
      status: 'used',
      note: '',
    };
    if (verified && !spec) {
      entry.status = 'unknown';
      entry.note = 'This llama-server doesn’t list this flag, so it won’t start.';
    } else if (occ.inline) {
      entry.status = 'invalid';
      entry.note = `llama-server rejects ${occ.written}=value. Use ${occ.written} value.`;
    } else if (spec?.valueHint && occ.value === null) {
      entry.status = 'invalid';
      entry.note = 'Needs a value, so the server won’t start.';
    } else if (lastByKey.get(key) !== i) {
      entry.status = 'overridden';
      entry.note = 'Set again later in the command. Only the last one is used.';
    } else if (addedKeys.has(key)) {
      entry.status = 'overridden';
      entry.note = 'Clara appends the opposite flag at start, and the last one wins.';
    }
    return entry;
  });

  const lastValue = (names: readonly string[]): string | null => {
    for (let i = occurrences.length - 1; i >= 0; i--) {
      const occ = occurrences[i] as LlamaFlagOccurrence;
      if (names.includes(occ.name)) {
        return occ.value;
      }
    }
    return null;
  };
  const ctx: ClassifyContext = {
    entries,
    value: lastValue,
    has: (names) => occurrences.some((occ) => names.includes(occ.name)),
  };

  for (const entry of entries) {
    if (entry.status !== 'used') {
      continue;
    }
    const names = flagGroupNames(entry.flag, entry.spec);
    if (names.includes('--port') && entry.value === PORT_TOKEN) {
      entry.status = 'managed';
      entry.note = 'Clara picks a free port at start.';
      continue;
    }
    const override = requestOverrides.find((o) => o.names.some((n) => names.includes(n)));
    if (override) {
      entry.status = 'request';
      entry.note = `Clara sends ${override.label} with every request, so this is only a fallback.`;
      continue;
    }
    if (names.includes('--gpu-layers') || names.includes('-ngl')) {
      if (entry.value === '99') {
        entry.status = 'rewritten';
        entry.note = 'Clara starts this as auto, so --fit can keep the model in VRAM.';
        continue;
      }
    }
    const note = interactionNote(entry, ctx);
    if (note) {
      entry.status = 'no-effect';
      entry.note = note;
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  if (!trimmed) {
    errors.push('Run command is empty.');
  } else {
    const ports = trimmed.split(PORT_TOKEN).length - 1;
    if (ports !== 1) {
      errors.push(
        ports === 0
          ? `Needs one ${PORT_TOKEN} so Clara can assign the port.`
          : `Needs exactly one ${PORT_TOKEN} (found ${ports}).`,
      );
    }
    const strict = tokenizeManagedLlamaCommand(trimmed.split(PORT_TOKEN).join('0'));
    if (!strict.ok) {
      errors.push(strict.error);
    }
    const binary = scanLlamaCommandTokens(trimmed)[0]?.text ?? '';
    if (isLlamaFlagToken(binary)) {
      errors.push('Must start with llama-server.');
    } else if (!/(?:^|[/\\])llama-server(?:\.exe)?$/i.test(binary)) {
      errors.push(`Clara only runs llama-server, not ${binary}.`);
    }
    if (!ctx.has(['-m', '--model', '-hf', '-hfr', '--hf-repo'])) {
      warnings.push('No model is set (-m or -hf).');
    } else if (ctx.has(['-m', '--model']) && ctx.has(['-hf', '-hfr', '--hf-repo'])) {
      warnings.push('Both -m and -hf are set. Keep one.');
    }
    const fa = lastValue(['-fa', '--flash-attn']);
    const quantizedCache = [lastValue(['-ctk', '--cache-type-k']), lastValue(['-ctv', '--cache-type-v'])].some(
      (v) => !!v && QUANTIZED_CACHE_RE.test(v),
    );
    if (fa === 'off' && quantizedCache) {
      warnings.push('A quantized KV cache needs flash attention, but -fa is off.');
    }
  }

  const addedAtStart = addedOccurrences.map((occ) => ({
    flag: occ.written,
    value: occ.value,
    note: ADDED_FLAG_NOTES[occ.written] ?? '',
  }));
  return { errors, warnings, entries, addedAtStart, startCommand, verified };
}

/** Pasted commands often use shell line continuations; the launcher only takes one line. */
export function normalizeLlamaCommandInput(raw: string): string {
  return (raw || '').replace(/\s*(?:\\|\^|`)?\r?\n\s*/g, ' ');
}

/** Rewrite one entry's value. An ``--x=y`` entry becomes ``--x y``. */
export function setLlamaEntryValue(
  command: string,
  entry: Pick<LlamaCommandEntry, 'flag' | 'start' | 'end'>,
  value: string,
  platform: ShellQuotingPlatform,
): string {
  const replacement = value === '' ? entry.flag : `${entry.flag} ${shellQuoteArg(value, platform)}`;
  return `${command.slice(0, entry.start)}${replacement}${command.slice(entry.end)}`;
}

export function removeLlamaEntry(command: string, entry: Pick<LlamaCommandEntry, 'start' | 'end'>): string {
  return spliceOutLlamaSpans(command, [entry]);
}

/** Append a flag, with its value when it takes one. */
export function appendLlamaFlag(
  command: string,
  flag: string,
  value: string | null,
  platform: ShellQuotingPlatform,
): string {
  const tail = value === null ? flag : `${flag} ${shellQuoteArg(value, platform)}`;
  const trimmed = (command || '').trim();
  return trimmed ? `${trimmed} ${tail}` : tail;
}

/** Name to write for a catalog entry: its first spelling that isn't a negation. */
export function preferredLlamaFlagName(spec: LlamaFlagSpec): string {
  return spec.names.find((n) => !n.startsWith('--no-')) ?? (spec.names[0] as string);
}

export interface LlamaFlagChange {
  flag: string;
  from: string | null;
  to: string | null;
}

function effectiveValues(command: string, index: Map<string, LlamaFlagSpec>): Map<string, { flag: string; value: string | null }> {
  const values = new Map<string, { flag: string; value: string | null }>();
  for (const occ of parseLlamaFlagOccurrences(command, arityFrom(index))) {
    const spec = index.get(occ.name) ?? null;
    if (flagGroupNames(occ.name, spec).includes('--port')) {
      continue;
    }
    values.set(flagKey(occ.name, spec), { flag: occ.written, value: occ.value });
  }
  return values;
}

/**
 * Flags that differ between the running server's command and the one saved now. The port and the
 * binary path are ignored: Clara assigns both at start.
 */
export function diffLlamaCommands(
  launched: string,
  current: string,
  catalog: LlamaFlagCatalog | null,
): LlamaFlagChange[] {
  const index = catalogIndex(catalog);
  const before = effectiveValues(launched, index);
  const after = effectiveValues(current, index);
  const changes: LlamaFlagChange[] = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) {
      changes.push({ flag: was.flag, from: was.value ?? 'on', to: null });
    } else if (now.value !== was.value) {
      changes.push({ flag: now.flag, from: was.value, to: now.value });
    }
  }
  for (const [key, now] of after) {
    if (!before.has(key)) {
      changes.push({ flag: now.flag, from: null, to: now.value ?? 'on' });
    }
  }
  return changes;
}

const MODEL_IDENTITY_FLAGS = ['-m', '--model', '-hf', '-hfr', '--hf-repo', '-mm', '--mmproj', '--no-mmproj', '--no-mmproj-auto'];

/**
 * Copy flags from the previous command that a rebuilt one lacks, so picking another model keeps the
 * user's tuning (``--no-mmap``, ``--spec-type``, ...). The model flags themselves stay as rebuilt.
 */
export function carryCustomLlamaFlags(previous: string, rebuilt: string): string {
  const present = new Set(parseLlamaFlagOccurrences(rebuilt).map((occ) => flagKey(occ.name, null)));
  let out = rebuilt;
  for (const occ of parseLlamaFlagOccurrences(previous)) {
    const key = flagKey(occ.name, null);
    if (present.has(key) || MODEL_IDENTITY_FLAGS.includes(occ.name)) {
      continue;
    }
    present.add(key);
    out = `${out} ${previous.slice(occ.start, occ.end)}`;
  }
  return out;
}
