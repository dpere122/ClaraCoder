import { describe, expect, it } from 'vitest';
import {
  analyzeLlamaRunCommand,
  appendLlamaFlag,
  buildManagedChatStartCommand,
  carryCustomLlamaFlags,
  diffLlamaCommands,
  normalizeLlamaCommandInput,
  parseLlamaServerHelp,
  removeLlamaEntry,
  setLlamaEntryValue,
  type LlamaAnalyzeOptions,
} from './llama-run-command';
import { parseManagedLlamaContextSize, parseManagedLlamaModelSelection, parseManagedLlamaNgl } from './managed-llama-model-pick';
import {
  hasLlamaFlag,
  parseLlamaFlagOccurrences,
  readLlamaFlagValue,
  scanLlamaCommandTokens,
  tokenizeManagedLlamaCommand,
  upsertLlamaFlag,
} from './llama-command-tokens';
import { managedLlamaCmdUsesHfRemoteModel } from './llama-model-download';

/** Excerpt of real ``llama-server --help`` output (build 10867). */
const HELP = `----- common params -----

-h,    --help, --usage                  print usage and exit
-C,    --cpu-mask M                     CPU affinity mask: arbitrarily long hex. Complements cpu-range
                                        (default: "")
-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)
                                        (env: LLAMA_ARG_CTX_SIZE)
-n,    --predict, --n-predict N         number of tokens to predict (default: -1, -1 = infinity)
                                        (env: LLAMA_ARG_N_PREDICT)
-b,    --batch-size N                   logical maximum batch size (default: 2048)
                                        (env: LLAMA_ARG_BATCH)
-ub,   --ubatch-size N                  physical maximum batch size (default: 512)
                                        (env: LLAMA_ARG_UBATCH)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use ('on', 'off', or 'auto', default: 'auto')
                                        (env: LLAMA_ARG_FLASH_ATTN)
--perf, --no-perf                       whether to enable internal libllama performance timings (default:
                                        false)
                                        (env: LLAMA_ARG_PERF)
--rope-scaling {none,linear,yarn}       RoPE frequency scaling method, defaults to linear unless specified by
                                        the model
-ctk,  --cache-type-k TYPE              KV cache data type for K
                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
                                        (default: f16)
                                        (env: LLAMA_ARG_CACHE_TYPE_K)
-dev,  --device <dev1,dev2,..>          comma-separated list of devices to use for offloading (none = don't
                                        offload)
-ot,   --override-tensor <tensor name pattern>=<buffer type>,...
                                        override tensor buffer type
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,
                                        'auto', or 'all' (default: auto)
-sm,   --split-mode {none,layer,row,tensor}
                                        how to split the model across multiple GPUs, one of:
                                        - none: use one GPU only
                                        (env: LLAMA_ARG_SPLIT_MODE)
-m,    --model FNAME                    model path to load
-hf,   -hfr, --hf-repo <user>/<model>[:quant]
                                        Hugging Face model repository
--no-mmap                               do not memory-map model
--mmproj-auto, --no-mmproj, --no-mmproj-auto
                                        whether to use multimodal projector file (if available), useful when
                                        using -hf (default: enabled)
-mm,   --mmproj FILE                    path to a multimodal projector file

----- sampling params -----

--temp, --temperature N                 temperature (default: 0.80)
--top-k N                               top-k sampling (default: 40, 0 = disabled)

----- speculative params -----

--spec-draft-n-max N                    number of tokens to draft for speculative decoding (default: 3)
--spec-type none,draft-simple,draft-mtp,ngram-simple
                                        comma-separated list of types of speculative decoding to use (default:
                                        none)

                                        (env: LLAMA_ARG_SPEC_TYPE)

----- example-specific params -----

--host HOST                             ip address to listen (default: 127.0.0.1)
--port PORT                             port to listen (default: 8080)
-np,   --parallel N                     number of server slots (default: -1, -1 = auto)
-cram, --cache-ram N                    set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 -
                                        disable)
--ui,  --webui, --no-ui, --no-webui     whether to enable the Web UI (default: enabled)
--jinja, --no-jinja                     whether to use jinja template engine for chat (default: enabled)
--metrics                               enable prometheus compatible metrics endpoint (default: disabled)
`;

const catalog = parseLlamaServerHelp(HELP, 'build 10867');
const options: LlamaAnalyzeOptions = { catalog, platform: 'posix' };
const BASE = 'llama-server --host 127.0.0.1 --port {{PORT}} --jinja -m /m/a.gguf --no-webui -np 1 --cache-ram 0';

function entry(command: string, flag: string, opts: LlamaAnalyzeOptions = options) {
  const found = analyzeLlamaRunCommand(command, opts).entries.filter((e) => e.flag === flag);
  return found[found.length - 1];
}

describe('parseLlamaServerHelp', () => {
  const byName = (name: string) => catalog.flags.find((f) => f.names.includes(name));

  it('reads aliases and value hints', () => {
    expect(byName('-ngl')?.names).toEqual(['-ngl', '--gpu-layers', '--n-gpu-layers']);
    expect(byName('-c')?.valueHint).toBe('N');
    expect(byName('--no-mmap')?.valueHint).toBeNull();
    expect(byName('--ui')?.names).toEqual(['--ui', '--webui', '--no-ui', '--no-webui']);
    expect(byName('--ui')?.valueHint).toBeNull();
  });

  it('keeps a hint that contains spaces, and a description on the next line', () => {
    expect(byName('-ot')?.valueHint).toBe('<tensor name pattern>=<buffer type>,...');
    expect(byName('-hf')?.valueHint).toBe('<user>/<model>[:quant]');
    expect(byName('-hf')?.description).toBe('Hugging Face model repository');
    expect(byName('--no-mmproj')?.valueHint).toBeNull();
  });

  it('finds enumerated values, but not placeholders that merely contain commas', () => {
    expect(byName('-fa')?.choices).toEqual(['on', 'off', 'auto']);
    expect(byName('-sm')?.choices).toEqual(['none', 'layer', 'row', 'tensor']);
    expect(byName('--spec-type')?.choices).toEqual(['none', 'draft-simple', 'draft-mtp', 'ngram-simple']);
    expect(byName('-ctk')?.choices).toContain('q8_0');
    expect(byName('-dev')?.choices).toBeNull();
    expect(byName('-c')?.choices).toBeNull();
  });

  it('leaves env lines out of the description', () => {
    expect(byName('-b')?.description).not.toContain('LLAMA_ARG');
  });
});

describe('token readers', () => {
  it('keeps a quoted value in one piece', () => {
    const cmd = `llama-server -m 'C:\\models -c 3\\a.gguf' -c 8192`;
    expect(scanLlamaCommandTokens(cmd).map((t) => t.text)).toEqual([
      'llama-server',
      '-m',
      'C:\\models -c 3\\a.gguf',
      '-c',
      '8192',
    ]);
    expect(parseManagedLlamaContextSize(cmd)).toBe(8192);
  });

  it('does not read a flag out of a path', () => {
    expect(parseManagedLlamaContextSize(`llama-server -m '/a -c 99/m.gguf'`)).toBeNull();
  });

  it('matches case exactly: -C is the CPU mask, not the context', () => {
    expect(parseManagedLlamaContextSize('llama-server -C ff')).toBeNull();
    expect(parseManagedLlamaContextSize('llama-server -C ff -c 4096')).toBe(4096);
  });

  it('reads the last occurrence, as llama.cpp does', () => {
    expect(parseManagedLlamaContextSize('llama-server -c 1024 --ctx-size 2048')).toBe(2048);
    expect(parseManagedLlamaNgl('llama-server -ngl 5 -ngl 7')).toBe(7);
  });

  it('recognizes the long spellings of the model flags', () => {
    expect(parseManagedLlamaModelSelection('llama-server --model /m/a.gguf')).toEqual({
      kind: 'gguf',
      absolutePath: '/m/a.gguf',
    });
    expect(parseManagedLlamaModelSelection('llama-server --hf-repo org/m:Q4')).toEqual({ kind: 'hf', hfId: 'org/m:Q4' });
  });

  it('treats a negative number as a value and underscores as dashes', () => {
    expect(readLlamaFlagValue('llama-server --keep -1', ['--keep'])).toBe('-1');
    expect(readLlamaFlagValue('llama-server --ctx_size 5', ['--ctx-size'])).toBe('5');
  });

  it('survives a half-typed command', () => {
    expect(hasLlamaFlag(`llama-server -m 'unfinished --jinja`, ['--jinja'])).toBe(false);
    expect(parseLlamaFlagOccurrences('')).toEqual([]);
  });

  it('upserts in place, keeps the alias, and clears earlier duplicates', () => {
    expect(upsertLlamaFlag('llama-server --ctx-size 1 --jinja', ['-c', '--ctx-size'], '-c', '2', 'posix')).toBe(
      'llama-server --ctx-size 2 --jinja',
    );
    expect(upsertLlamaFlag('llama-server -c 1 --jinja -c 2', ['-c', '--ctx-size'], '-c', '3', 'posix')).toBe(
      'llama-server --jinja -c 3',
    );
    expect(upsertLlamaFlag('llama-server --jinja', ['-c', '--ctx-size'], '-c', '3', 'posix')).toBe(
      'llama-server --jinja -c 3',
    );
    expect(upsertLlamaFlag('llama-server --ctx-size=1 --jinja', ['-c', '--ctx-size'], '-c', '3', 'posix')).toBe(
      'llama-server --ctx-size 3 --jinja',
    );
  });

  it('removes a flag without touching spaces inside a quoted path', () => {
    expect(upsertLlamaFlag(`llama-server -m '/a  b/c.gguf' -c 1`, ['-c'], '-c', null, 'posix')).toBe(
      `llama-server -m '/a  b/c.gguf'`,
    );
  });
});

describe('analyzeLlamaRunCommand', () => {
  it('reports a healthy command as used, with the port managed by Clara', () => {
    const result = analyzeLlamaRunCommand(`${BASE} -c 4096`, options);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.verified).toBe(true);
    expect(entry(`${BASE} -c 4096`, '-c')?.status).toBe('used');
    expect(entry(`${BASE} -c 4096`, '--port')?.status).toBe('managed');
  });

  it('marks earlier duplicates as overridden, across aliases', () => {
    const entries = analyzeLlamaRunCommand(`${BASE} -c 1 --ctx-size 2`, options).entries;
    expect(entries.find((e) => e.flag === '-c')?.status).toBe('overridden');
    expect(entries.find((e) => e.flag === '--ctx-size')?.status).toBe('used');
  });

  it('flags what the installed server does not list', () => {
    expect(entry(`${BASE} --bogus`, '--bogus')?.status).toBe('unknown');
  });

  it('flags --x=y, which llama-server rejects', () => {
    expect(entry(`${BASE} --ctx-size=5`, '--ctx-size')?.status).toBe('invalid');
  });

  it('flags a missing value, and consumes the next flag as llama.cpp does', () => {
    expect(entry(`${BASE} -fa`, '-fa')?.status).toBe('invalid');
    expect(entry(`llama-server --port {{PORT}} -m a -fa -c 5`, '-fa')?.value).toBe('-c');
  });

  it('does not call flags unknown when the server has not been asked', () => {
    const offline = analyzeLlamaRunCommand(`${BASE} --bogus`, { platform: 'posix' });
    expect(offline.verified).toBe(false);
    expect(offline.entries.find((e) => e.flag === '--bogus')?.status).toBe('used');
  });

  it('shows sampling flags as fallbacks when Clara sends them per request', () => {
    const opts: LlamaAnalyzeOptions = {
      ...options,
      requestOverrides: [{ names: ['--temp'], label: 'Temperature' }],
    };
    const temp = entry(`${BASE} --temperature 0.2`, '--temperature', opts);
    expect(temp?.status).toBe('request');
    expect(temp?.note).toContain('Temperature');
    expect(entry(`${BASE} --top-k 5`, '--top-k', opts)?.status).toBe('used');
  });

  it('explains -ngl 99, which Clara starts as auto', () => {
    expect(entry(`${BASE} -ngl 99`, '-ngl')?.status).toBe('rewritten');
    expect(entry(`${BASE} -ngl 12`, '-ngl')?.status).toBe('used');
  });

  it('detects flags made pointless by another flag', () => {
    expect(entry(`${BASE} --mmproj /p.gguf --no-mmproj`, '--mmproj')?.status).toBe('no-effect');
    expect(entry(`${BASE} -b 256 -ub 512`, '-ub')?.status).toBe('no-effect');
    expect(entry(`${BASE} -ub 512`, '-ub')?.status).toBe('used');
    expect(entry(`${BASE} --spec-draft-n-max 4`, '--spec-draft-n-max')?.status).toBe('no-effect');
    expect(entry(`${BASE} --spec-type draft-mtp --spec-draft-n-max 4`, '--spec-draft-n-max')?.status).toBe('used');
  });

  it('lists what Clara appends at start, and marks a flag that loses to it', () => {
    const bare = 'llama-server --port {{PORT}} -m /m/a.gguf';
    const result = analyzeLlamaRunCommand(bare, options);
    expect(result.addedAtStart.map((f) => f.flag)).toEqual(['--jinja', '--no-webui', '-np', '--cache-ram']);
    expect(result.startCommand).toBe(`${bare} --jinja --no-webui -np 1 --cache-ram 0`);
    expect(entry(`${bare} --no-jinja`, '--no-jinja')?.status).toBe('overridden');
  });

  it('adds the Gemma reasoning format only for the Gemma preset', () => {
    const opts = { ...options, optimizationPreset: 'gemma' };
    expect(analyzeLlamaRunCommand(BASE, opts).addedAtStart.map((f) => f.flag)).toEqual(['--reasoning-format']);
    expect(analyzeLlamaRunCommand(BASE, options).addedAtStart).toEqual([]);
  });

  it('reports command-level problems', () => {
    expect(analyzeLlamaRunCommand('', options).errors[0]).toContain('empty');
    expect(analyzeLlamaRunCommand('llama-server -m a', options).errors[0]).toContain('{{PORT}}');
    expect(analyzeLlamaRunCommand('llama-server --port {{PORT}} {{PORT}} -m a', options).errors[0]).toContain('found 2');
    expect(analyzeLlamaRunCommand('python --port {{PORT}} -m a', options).errors[0]).toContain('only runs llama-server');
    expect(analyzeLlamaRunCommand(`llama-server --port {{PORT}} -m 'a`, options).errors[0]).toContain('unbalanced');
    expect(analyzeLlamaRunCommand('llama-server --port {{PORT}}', options).warnings[0]).toContain('No model');
    expect(analyzeLlamaRunCommand('llama-server --port {{PORT}} -m a -hf b', options).warnings[0]).toContain('Both');
    expect(
      analyzeLlamaRunCommand('llama-server --port {{PORT}} -m a -fa off -ctv q8_0', options).warnings[0],
    ).toContain('flash attention');
    expect(analyzeLlamaRunCommand('llama-server --port {{PORT}} -m a -fa off -ctk q8_0', options).warnings).toEqual([]);
  });

  it('keeps entry ids stable when a value changes', () => {
    const a = analyzeLlamaRunCommand(`${BASE} -c 1`, options).entries.map((e) => e.id);
    const b = analyzeLlamaRunCommand(`${BASE} -c 22222`, options).entries.map((e) => e.id);
    expect(a).toEqual(b);
  });
});

describe('editing', () => {
  it('sets a value in place, quoting when needed', () => {
    const cmd = `${BASE} -c 1 --metrics`;
    const c = entry(cmd, '-c')!;
    expect(setLlamaEntryValue(cmd, c, '2048', 'posix')).toBe(`${BASE} -c 2048 --metrics`);
    const m = entry(cmd, '-m')!;
    expect(setLlamaEntryValue(cmd, m, '/a b/c.gguf', 'posix')).toContain(`-m '/a b/c.gguf'`);
  });

  it('turns --x=y into --x y', () => {
    const cmd = `${BASE} --ctx-size=5`;
    expect(setLlamaEntryValue(cmd, entry(cmd, '--ctx-size')!, '5', 'posix')).toBe(`${BASE} --ctx-size 5`);
  });

  it('removes an entry and appends a new one', () => {
    const cmd = `${BASE} -c 1 --metrics`;
    expect(removeLlamaEntry(cmd, entry(cmd, '-c')!)).toBe(`${BASE} --metrics`);
    expect(appendLlamaFlag(BASE, '--metrics', null, 'posix')).toBe(`${BASE} --metrics`);
    expect(appendLlamaFlag(BASE, '-c', '1', 'posix')).toBe(`${BASE} -c 1`);
  });

  it('joins pasted shell line continuations', () => {
    expect(normalizeLlamaCommandInput('llama-server \\\n  -c 1 ^\r\n  --jinja\n--metrics')).toBe(
      'llama-server -c 1 --jinja --metrics',
    );
  });
});

describe('buildManagedChatStartCommand', () => {
  it('promotes -ngl 99 and appends the managed defaults', () => {
    expect(buildManagedChatStartCommand('llama-server --port {{PORT}} -ngl 99', undefined, 'posix')).toBe(
      'llama-server --port {{PORT}} -ngl auto --jinja --no-webui -np 1 --cache-ram 0',
    );
  });
});

describe('diffLlamaCommands', () => {
  it('ignores the port and binary path, and reports changes by option', () => {
    const launched = '"C:\\bin\\llama-server.exe" --port 51000 -c 4096 -ngl auto --metrics';
    expect(diffLlamaCommands(launched, 'llama-server --port {{PORT}} --ctx-size 4096 -ngl auto --metrics', catalog)).toEqual(
      [],
    );
    expect(diffLlamaCommands(launched, 'llama-server --port {{PORT}} -c 8192 -ngl auto -fa on', catalog)).toEqual([
      { flag: '-c', from: '4096', to: '8192' },
      { flag: '--metrics', from: 'on', to: null },
      { flag: '-fa', from: null, to: 'on' },
    ]);
  });
});

describe('editing entries', () => {
  const options = { catalog, platform: 'posix' as const };
  const entryFor = (command: string, flag: string) => {
    const entry = analyzeLlamaRunCommand(command, options).entries.find((e) => e.flag === flag);
    if (!entry) {
      throw new Error(`no ${flag} entry`);
    }
    return entry;
  };

  it('applies spans to the trimmed command that was analyzed', () => {
    const command = '  llama-server --port {{PORT}} -m a -c 1 -b 2';
    expect(setLlamaEntryValue(command, entryFor(command, '-c'), '9', 'posix')).toBe(
      'llama-server --port {{PORT}} -m a -c 9 -b 2',
    );
    expect(removeLlamaEntry(command, entryFor(command, '-c'))).toBe('llama-server --port {{PORT}} -m a -b 2');
  });

  it('removes every value of a flag that takes two', () => {
    const command = 'llama-server --port {{PORT}} --control-vector-layer-range 1 5 -c 1';
    const entry = analyzeLlamaRunCommand(command, { platform: 'posix' }).entries.find(
      (e) => e.flag === '--control-vector-layer-range',
    );
    expect(entry && removeLlamaEntry(command, entry)).toBe('llama-server --port {{PORT}} -c 1');
  });

  it('writes values the launcher reads back as one argument', () => {
    const json = '{"enable_thinking":false}';
    for (const platform of ['win32', 'posix'] as const) {
      for (const value of [json, '#abc', "it's", 'a b']) {
        const written = appendLlamaFlag('llama-server', '--x', value, platform);
        expect(tokenizeManagedLlamaCommand(written)).toEqual({ ok: true, argv: ['llama-server', '--x', value] });
      }
    }
  });

  it('classifies underscore spellings like the dashed flag', () => {
    const entries = analyzeLlamaRunCommand('llama-server --port {{PORT}} -m a --gpu_layers 99', {
      platform: 'posix',
    }).entries;
    expect(entries.find((e) => e.flag === '--gpu_layers')?.status).toBe('rewritten');
  });
});

describe('diffLlamaCommands toggles', () => {
  it('notices a flag switched to its negation', () => {
    const changes = diffLlamaCommands('llama-server --ui', 'llama-server --no-ui', catalog);
    expect(changes).toEqual([{ flag: '--no-ui', from: '--ui', to: '--no-ui' }]);
  });
});

describe('managedLlamaCmdUsesHfRemoteModel', () => {
  it('knows every spelling of the Hugging Face repo flag, and not a path that mentions it', () => {
    for (const flag of ['-hf org/m', '-hfr org/m', '--hf-repo org/m', '--hf-url https://x']) {
      expect(managedLlamaCmdUsesHfRemoteModel(`llama-server ${flag}`)).toBe(true);
    }
    expect(managedLlamaCmdUsesHfRemoteModel('llama-server -m "/models -hf x/a.gguf"')).toBe(false);
  });
});

describe('carryCustomLlamaFlags', () => {
  it('leaves flags that name the previous model behind', () => {
    const previous = 'llama-server --port {{PORT}} -hf org/old -hff old-Q4.gguf -mmu https://x/mm.gguf --no-mmap';
    expect(carryCustomLlamaFlags(previous, 'llama-server --port {{PORT}} -hf org/new')).toBe(
      'llama-server --port {{PORT}} -hf org/new --no-mmap',
    );
  });

  it('keeps custom tuning when the model changes, but not the old model or a stale duplicate', () => {
    const previous = `llama-server --port {{PORT}} -m '/old model.gguf' -c 4096 --no-mmap --spec-type draft-mtp -mm /old-mm.gguf`;
    const rebuilt = 'llama-server --port {{PORT}} -m /new.gguf -c 8192';
    expect(carryCustomLlamaFlags(previous, rebuilt)).toBe(
      'llama-server --port {{PORT}} -m /new.gguf -c 8192 --no-mmap --spec-type draft-mtp',
    );
  });
});
