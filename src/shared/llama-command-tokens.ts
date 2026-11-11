/**
 * Argv-level view of a managed ``llama-server`` run command.
 *
 * llama.cpp matches flags exactly (``-C`` is the CPU mask, ``-c`` the context) and keeps the last
 * value of a repeated flag, so readers here work on tokens rather than regexes over the raw string:
 * a path such as ``'C:\models -c 3\a.gguf'`` is one value, not a flag.
 */

export type ShellQuotingPlatform = 'win32' | 'posix';

export const MODEL_FLAG_NAMES = ['-m', '--model'];
export const HF_FLAG_NAMES = ['-hf', '-hfr', '--hf-repo'];
export const CTX_FLAG_NAMES = ['-c', '--ctx-size'];
export const NGL_FLAG_NAMES = ['-ngl', '--gpu-layers', '--n-gpu-layers'];
export const FA_FLAG_NAMES = ['-fa', '--flash-attn'];
export const CTK_FLAG_NAMES = ['-ctk', '--cache-type-k'];
export const CTV_FLAG_NAMES = ['-ctv', '--cache-type-v'];
export const QUANTIZED_CACHE_TYPE_RE = /^(?:q\d|iq\d)/i;
export const SPEC_TYPE_FLAG_NAMES = ['--spec-type'];
export const LOCAL_DRAFT_MODEL_FLAG_NAMES = ['-md', '--model-draft', '--spec-draft-model'];
export const DRAFT_MODEL_FLAG_NAMES = [
  ...LOCAL_DRAFT_MODEL_FLAG_NAMES,
  '-hfd',
  '-hfrd',
  '--spec-draft-hf',
  '--hf-repo-draft',
];

/** The ``-fa`` values llama.cpp reads as off. It matches them exactly, like its ``is_falsey``. */
export function isLlamaFlashAttnOff(value: string | null): boolean {
  return value === 'off' || value === 'disabled' || value === 'false' || value === '0';
}

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

/** Disallowed shell metacharacters (unquoted tokens; newlines are rejected on the full string). */
export const MANAGED_LLAMA_SHELL_METACHAR_RE = /[;|&<>`$(){}!*\n\r~#]/;
const UNQUOTED_TOKEN_METACHAR_RE = /[;|&<>`$(){}!*~#]/;
const METACHAR_ERROR =
  'Run command contains disallowed shell metacharacters (; | & < > ` $ ( ) { } ! * # ~ or newlines).';

/**
 * Quote a value so {@link tokenizeManagedLlamaCommand} reads it back as one argument. The launcher
 * runs no shell and has no escapes, so a value holding one kind of quote is wrapped in the other.
 */
export function quoteLlamaFlagValue(value: string, platform: ShellQuotingPlatform): string {
  const hasDouble = value.includes('"');
  const hasSingle = value.includes("'");
  if (hasDouble && !hasSingle) {
    return `'${value}'`;
  }
  if (hasSingle && !hasDouble) {
    return `"${value}"`;
  }
  return !hasDouble && UNQUOTED_TOKEN_METACHAR_RE.test(value) ? `"${value}"` : shellQuoteArg(value, platform);
}

/**
 * Tokenize a prepared managed run command into argv.
 * Honors single/double quotes; rejects unbalanced quotes and unquoted shell metacharacters.
 * Quoted tokens may contain path characters such as ``()`` (e.g. ``Program Files (x86)``).
 */
export function tokenizeManagedLlamaCommand(
  command: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  if (/[\n\r]/.test(command)) {
    return { ok: false, error: METACHAR_ERROR };
  }
  const argv: string[] = [];
  let i = 0;
  const s = command;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
      i++;
    }
    if (i >= s.length) {
      break;
    }
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      let token = '';
      let closed = false;
      while (i < s.length) {
        if (s[i] === q) {
          closed = true;
          i++;
          break;
        }
        token += s[i];
        i++;
      }
      if (!closed) {
        return { ok: false, error: 'Run command has unbalanced quotes.' };
      }
      argv.push(token);
      continue;
    }
    let token = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '"' && s[i] !== "'") {
      token += s[i];
      i++;
    }
    // Reject shell-style adjacent quotes (e.g. --chat-template-file="/path with spaces").
    // Supported forms: --flag value, --flag=/path (no spaces), or a fully quoted token.
    if (i < s.length && (s[i] === '"' || s[i] === "'")) {
      return {
        ok: false,
        error:
          'Run command has quotes adjacent to an unquoted token (e.g. --flag="value"). Use --flag value or --flag=value without adjacent quotes.',
      };
    }
    if (UNQUOTED_TOKEN_METACHAR_RE.test(token)) {
      return { ok: false, error: METACHAR_ERROR };
    }
    argv.push(token);
  }
  if (argv.length === 0) {
    return { ok: false, error: 'Run command is empty.' };
  }
  return { ok: true, argv };
}

export interface LlamaCommandToken {
  /** Unquoted text. */
  text: string;
  start: number;
  end: number;
}

/**
 * Split a command into tokens with their source spans. Never fails: forms and the editor have to
 * keep reading a half-typed command, so an unbalanced quote runs to the end of the string. Launch
 * validation is {@link tokenizeManagedLlamaCommand}.
 */
export function scanLlamaCommandTokens(command: string): LlamaCommandToken[] {
  const tokens: LlamaCommandToken[] = [];
  const s = command || '';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] as string)) {
      i++;
    }
    if (i >= s.length) {
      break;
    }
    const start = i;
    let text = '';
    while (i < s.length && !/\s/.test(s[i] as string)) {
      const ch = s[i] as string;
      if (ch === '"' || ch === "'") {
        const close = s.indexOf(ch, i + 1);
        const end = close === -1 ? s.length : close;
        text += s.slice(i + 1, end);
        i = close === -1 ? s.length : close + 1;
        continue;
      }
      text += ch;
      i++;
    }
    tokens.push({ text, start, end: i });
  }
  return tokens;
}

/** True for ``-x`` / ``--long``; a negative number such as ``-1`` is a value. */
export function isLlamaFlagToken(text: string): boolean {
  return /^--?[^\d\s.-]/.test(text) || /^--[^\s-]/.test(text);
}

/** llama.cpp treats ``_`` as ``-`` in long options (``--ctx_size``). Short options stay exact. */
export function normalizeLlamaFlagName(name: string): string {
  return name.startsWith('--') ? name.replace(/_/g, '-') : name;
}

export interface LlamaFlagOccurrence {
  /** Normalized name, without any ``=value``. */
  name: string;
  /** Name as written in the command. */
  written: string;
  /** ``null`` for a flag with no value. */
  value: string | null;
  /** True for the ``--flag=value`` form. */
  inline: boolean;
  /** Source span of the flag and its value. */
  start: number;
  end: number;
  /** End of any further bare tokens, which belong to this flag (``--range START END``). */
  tailEnd: number;
}

/**
 * Whether a flag takes a value: ``true`` / ``false`` when known, ``undefined`` to decide from the
 * next token (a following non-flag token is its value).
 */
export type LlamaFlagArity = (name: string) => boolean | undefined;

/** Every flag in the command, in order. The binary (a leading non-flag token) is skipped. */
export function parseLlamaFlagOccurrences(command: string, arity?: LlamaFlagArity): LlamaFlagOccurrence[] {
  const tokens = scanLlamaCommandTokens(command);
  const out: LlamaFlagOccurrence[] = [];
  let i = tokens[0] && !isLlamaFlagToken(tokens[0].text) ? 1 : 0;
  while (i < tokens.length) {
    const token = tokens[i] as LlamaCommandToken;
    i++;
    if (!isLlamaFlagToken(token.text)) {
      // llama-server takes no positional arguments, so a bare token is still the previous flag's.
      const previous = out[out.length - 1];
      if (previous) {
        previous.tailEnd = token.end;
      }
      continue;
    }
    const eq = token.text.startsWith('--') ? token.text.indexOf('=') : -1;
    if (eq !== -1) {
      const written = token.text.slice(0, eq);
      out.push({
        name: normalizeLlamaFlagName(written),
        written,
        value: token.text.slice(eq + 1),
        inline: true,
        start: token.start,
        end: token.end,
        tailEnd: token.end,
      });
      continue;
    }
    const name = normalizeLlamaFlagName(token.text);
    const next = tokens[i];
    const takesValue = arity?.(name) ?? (!!next && !isLlamaFlagToken(next.text));
    if (takesValue && next) {
      out.push({
        name,
        written: token.text,
        value: next.text,
        inline: false,
        start: token.start,
        end: next.end,
        tailEnd: next.end,
      });
      i++;
      continue;
    }
    out.push({
      name,
      written: token.text,
      value: null,
      inline: false,
      start: token.start,
      end: token.end,
      tailEnd: token.end,
    });
  }
  return out;
}

/** Occurrences of one flag by any of its names, in command order. */
export function findLlamaFlag(command: string, names: readonly string[]): LlamaFlagOccurrence[] {
  return parseLlamaFlagOccurrences(command).filter((occ) => names.includes(occ.name));
}

/** The occurrence llama.cpp uses: the last one. */
export function lastLlamaFlag(command: string, names: readonly string[]): LlamaFlagOccurrence | null {
  return findLlamaFlag(command, names).pop() ?? null;
}

/** Value of the last occurrence, or ``null`` when absent or valueless. */
export function readLlamaFlagValue(command: string, names: readonly string[]): string | null {
  return lastLlamaFlag(command, names)?.value ?? null;
}

export function hasLlamaFlag(command: string, names: readonly string[]): boolean {
  return findLlamaFlag(command, names).length > 0;
}

/** True when the command asks for MTP decoding. llama.cpp adds up repeated ``--spec-type`` flags. */
export function llamaCommandUsesDraftMtp(command: string): boolean {
  return findLlamaFlag(command, SPEC_TYPE_FLAG_NAMES).some((occ) => (occ.value ?? '').split(',').includes('draft-mtp'));
}

/** Remove source spans (and the whitespace before each) without touching anything else. */
export function spliceOutLlamaSpans(
  command: string,
  spans: readonly { start: number; end: number; tailEnd?: number }[],
): string {
  let out = command;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    let from = span.start;
    while (from > 0 && /\s/.test(out[from - 1] as string)) {
      from--;
    }
    out = out.slice(0, from) + out.slice(span.tailEnd ?? span.end);
  }
  return out.trim();
}

/**
 * Set a flag's value, keeping how it was written and where it sits. Earlier duplicates go too, so
 * the value written here is the one used. ``null`` removes the flag; a missing flag is appended
 * under ``canonical``.
 */
export function upsertLlamaFlag(
  command: string,
  names: readonly string[],
  canonical: string,
  value: string | null,
  platform: ShellQuotingPlatform,
): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const occurrences = findLlamaFlag(trimmed, names);
  if (value === null) {
    return spliceOutLlamaSpans(trimmed, occurrences);
  }
  const quoted = quoteLlamaFlagValue(value, platform);
  const last = occurrences.pop();
  if (!last) {
    return `${trimmed} ${canonical} ${quoted}`;
  }
  const replaced = `${trimmed.slice(0, last.start)}${last.written} ${quoted}${trimmed.slice(last.end)}`;
  return spliceOutLlamaSpans(replaced, occurrences);
}

/** Append or remove a valueless flag. */
export function setLlamaBooleanFlag(command: string, names: readonly string[], token: string, enabled: boolean): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const occurrences = findLlamaFlag(trimmed, names);
  if (enabled) {
    return occurrences.length ? trimmed : `${trimmed} ${token}`;
  }
  return spliceOutLlamaSpans(trimmed, occurrences);
}
