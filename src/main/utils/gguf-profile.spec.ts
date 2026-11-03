import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateManagedLlamaVram, estimateProfileMb } from '../../shared';
import type { CudaGpuDevice, GgufProfile } from '../../shared';
import { ggufProfileFromHeader, readGgufProfile, type GgufTensorSize, type GgufValue } from './gguf-profile';

const MIB = 1024 * 1024;

/** Write the bytes of a GGUF: integers, booleans, strings, and arrays of those. */
class GgufWriter {
  private readonly parts: Buffer[] = [];

  get length(): number {
    return this.parts.reduce((sum, part) => sum + part.length, 0);
  }

  raw(buf: Buffer): this {
    this.parts.push(buf);
    return this;
  }

  u32(n: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n);
    return this.raw(buf);
  }

  u64(n: number | bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(n));
    return this.raw(buf);
  }

  str(s: string): this {
    const bytes = Buffer.from(s, 'utf8');
    return this.u64(bytes.length).raw(bytes);
  }

  scalar(value: number | boolean | string): this {
    if (typeof value === 'string') {
      return this.u32(8).str(value);
    }
    return typeof value === 'boolean' ? this.u32(7).raw(Buffer.from([value ? 1 : 0])) : this.u32(4).u32(value);
  }

  kv(key: string, value: number | boolean | string | (number | boolean | string)[]): this {
    this.str(key);
    if (!Array.isArray(value)) {
      return this.scalar(value);
    }
    const first = value[0];
    if (typeof first === 'string') {
      this.u32(9).u32(8).u64(value.length);
      value.forEach((v) => this.str(v as string));
    } else if (typeof first === 'boolean') {
      this.u32(9).u32(7).u64(value.length);
      value.forEach((v) => this.raw(Buffer.from([v ? 1 : 0])));
    } else {
      this.u32(9).u32(4).u64(value.length);
      value.forEach((v) => this.u32(v as number));
    }
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

type KvEntries = Record<string, number | boolean | string | (number | boolean | string)[]>;

/** A complete GGUF with zeroed tensor data, laid out as llama.cpp's writer does. */
function gguf(kv: KvEntries, tensors: readonly { name: string; bytes: number }[], alignment = 32): Buffer {
  const w = new GgufWriter().raw(Buffer.from('GGUF')).u32(3).u64(tensors.length).u64(Object.keys(kv).length);
  Object.entries(kv).forEach(([key, value]) => w.kv(key, value));
  let offset = 0;
  for (const { name, bytes } of tensors) {
    w.str(name).u32(1).u64(bytes).u32(0).u64(offset);
    offset += Math.ceil(bytes / alignment) * alignment;
  }
  const dataStart = Math.ceil(w.length / alignment) * alignment;
  const last = tensors[tensors.length - 1];
  const tail = last ? offset - Math.ceil(last.bytes / alignment) * alignment + last.bytes : 0;
  return Buffer.concat([w.build(), Buffer.alloc(dataStart - w.length + tail)]);
}

describe('readGgufProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gguf-profile-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, bytes: Buffer): string => {
    const file = path.join(dir, name);
    writeFileSync(file, bytes);
    return file;
  };

  const hybrid: KvEntries = {
    'general.architecture': 'qwen35',
    'qwen35.block_count': 5,
    'qwen35.context_length': 262144,
    'qwen35.embedding_length': 4096,
    'qwen35.attention.head_count': 16,
    'qwen35.attention.head_count_kv': 4,
    'qwen35.attention.key_length': 256,
    'qwen35.attention.value_length': 128,
    'qwen35.nextn_predict_layers': 1,
    'qwen35.attention.recurrent_layers': [true, true, true, false, true],
    'qwen35.ssm.conv_kernel': 4,
    'qwen35.ssm.state_size': 8,
    'qwen35.ssm.inner_size': 16,
    'qwen35.ssm.group_count': 2,
  };

  it('reads what the VRAM estimate needs, with tensor sizes from their offsets', async () => {
    const profile = await readGgufProfile(
      write(
        'model.gguf',
        gguf(hybrid, [
          { name: 'token_embd.weight', bytes: 1000 },
          { name: 'output.weight', bytes: 500 },
          { name: 'blk.0.attn.weight', bytes: 64 },
          { name: 'blk.4.attn.weight', bytes: 96 },
          { name: 'blk.4.ffn.weight', bytes: 7 },
        ]),
      ),
    );
    expect(profile).toEqual({
      contextTrain: 262144,
      embeddingOut: 4096,
      nextnLayers: 1,
      // 1000 and 500 pad to 1024 and 512; the last tensor runs to the end of the file.
      tensorBytes: 1024 + 512 + 64 + 96 + 7,
      hostBytes: 1024,
      headBytes: 96 + 7,
      // Three recurrent layers below the head: ((4 - 1) * (16 + 2 * 2 * 8) + 8 * 16) * 4 bytes each.
      recurrentStateBytes: 3 * 1088,
      fullKeys: 4 * 256,
      fullValues: 4 * 128,
      maxFullKey: 4 * 256,
      swaKeys: 0,
      swaValues: 0,
      slidingWindow: 0,
      cacheLengths: [256, 128],
    });
  });

  it('honours general.alignment when placing the tensor data', async () => {
    const kv = { ...hybrid, 'general.alignment': 64 };
    const profile = await readGgufProfile(
      write('model.gguf', gguf(kv, [{ name: 'a.weight', bytes: 10 }, { name: 'b.weight', bytes: 10 }], 64)),
    );
    expect(profile?.tensorBytes).toBe(64 + 10);
  });

  it('adds up the tensors of every shard, taking the metadata from the first', async () => {
    const first = write(
      'model-00001-of-00002.gguf',
      gguf(hybrid, [{ name: 'token_embd.weight', bytes: 64 }, { name: 'output.weight', bytes: 32 }]),
    );
    write('model-00002-of-00002.gguf', gguf({ 'split.no': 1 }, [{ name: 'blk.4.attn.weight', bytes: 128 }]));
    const profile = await readGgufProfile(first);
    expect(profile?.tensorBytes).toBe(64 + 32 + 128);
    expect(profile?.hostBytes).toBe(64);
    expect(profile?.headBytes).toBe(128);
    expect(profile?.contextTrain).toBe(262144);
  });

  it('reads a header longer than the first read, skipping a tokenizer it does not keep', async () => {
    const kv: KvEntries = {
      'tokenizer.ggml.tokens': Array.from({ length: 40_000 }, (_, i) => `token-${i}`.padEnd(100, 'x')),
      'tokenizer.chat_template': 'x'.repeat(1000),
      ...hybrid,
    };
    const file = gguf(kv, [{ name: 'token_embd.weight', bytes: 64 }]);
    expect(file.length).toBeGreaterThan(3 * MIB);
    expect((await readGgufProfile(write('model.gguf', file)))?.contextTrain).toBe(262144);
  });

  it('skips a long numeric array, keeping none of it', async () => {
    const kv: KvEntries = { ...hybrid, 'tokenizer.ggml.token_type': Array.from({ length: 5000 }, () => 1) };
    expect((await readGgufProfile(write('model.gguf', gguf(kv, []))))?.contextTrain).toBe(262144);
  });

  describe('is null', () => {
    const valid = gguf(hybrid, [{ name: 'token_embd.weight', bytes: 64 }]);

    it('for a file that is not a GGUF, or is too short to be one', async () => {
      expect(await readGgufProfile(write('a.gguf', Buffer.from('not a gguf file at all, sorry')))).toBeNull();
      expect(await readGgufProfile(write('b.gguf', Buffer.from('GG')))).toBeNull();
      expect(await readGgufProfile(write('c.gguf', Buffer.alloc(0)))).toBeNull();
    });

    it('for a missing file or shard', async () => {
      expect(await readGgufProfile(path.join(dir, 'missing.gguf'))).toBeNull();
      expect(await readGgufProfile(write('m-00001-of-00002.gguf', valid))).toBeNull();
    });

    it('for a header cut off anywhere', async () => {
      for (const length of [4, 12, 24, 40, 200, valid.length - 80]) {
        expect(await readGgufProfile(write('cut.gguf', valid.subarray(0, length)))).toBeNull();
      }
    });

    it('for a tensor placed past the end of the file', async () => {
      const w = new GgufWriter().raw(Buffer.from('GGUF')).u32(3).u64(1).u64(2);
      w.kv('general.architecture', 'a').kv('a.block_count', 1);
      w.str('t').u32(1).u64(1).u32(0).u64(1024 * MIB);
      expect(await readGgufProfile(write('short.gguf', w.build()))).toBeNull();
    });

    it('for a version it does not know', async () => {
      const file = Buffer.from(valid);
      file.writeUInt32LE(1, 4);
      expect(await readGgufProfile(write('v1.gguf', file))).toBeNull();
      file.writeUInt32LE(4, 4);
      expect(await readGgufProfile(write('v4.gguf', file))).toBeNull();
    });

    it('for counts no real file has, without trying to read them', async () => {
      const head = () => new GgufWriter().raw(Buffer.from('GGUF')).u32(3);
      const manyKeys = head().u64(0).u64(BigInt(2) ** BigInt(60)).build();
      const manyTensors = head().u64(BigInt(2) ** BigInt(60)).u64(0).build();
      const hugeString = head().u64(0).u64(1).u64(BigInt(2) ** BigInt(62)).build();
      const hugeArray = head().u64(0).u64(1).str('k').u32(9).u32(8).u64(BigInt(2) ** BigInt(62)).build();
      const manyDims = head().u64(1).u64(0).str('t').u32(1000).build();
      for (const [name, file] of Object.entries({ manyKeys, manyTensors, hugeString, hugeArray, manyDims })) {
        expect(await readGgufProfile(write(`${name}.gguf`, file))).toBeNull();
      }
    });

    it('for a header with no architecture or layers', async () => {
      const noArch = gguf({ 'a.block_count': 5 }, []);
      const noLayers = gguf({ 'general.architecture': 'a' }, []);
      const tooManyLayers = gguf({ 'general.architecture': 'a', 'a.block_count': 4_000_000_000 }, []);
      expect(await readGgufProfile(write('no-arch.gguf', noArch))).toBeNull();
      expect(await readGgufProfile(write('no-layers.gguf', noLayers))).toBeNull();
      expect(await readGgufProfile(write('too-many-layers.gguf', tooManyLayers))).toBeNull();
    });
  });
});

/** Values from the headers of the real files. Tensor bytes are the spans between their offsets. */
const every = <T>(n: number, pick: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => pick(i));

function model(
  arch: string,
  keys: Record<string, GgufValue>,
  bytes: { total: number; tokenEmbd: number; perLayerEmbd?: number; output?: number; head?: number; headBlock?: number },
): GgufProfile {
  const tensors: GgufTensorSize[] = [{ name: 'token_embd.weight', bytes: bytes.tokenEmbd }];
  if (bytes.perLayerEmbd) {
    tensors.push({ name: 'per_layer_token_embd.weight', bytes: bytes.perLayerEmbd });
  }
  if (bytes.output) {
    tensors.push({ name: 'output.weight', bytes: bytes.output });
  }
  if (bytes.head) {
    tensors.push({ name: `blk.${bytes.headBlock}.attn_q.weight`, bytes: bytes.head });
  }
  const listed = tensors.reduce((sum, t) => sum + t.bytes, 0);
  tensors.push({ name: 'blk.0.attn_q.weight', bytes: bytes.total - listed });
  const kv = new Map<string, GgufValue>([['general.architecture', arch]]);
  Object.entries(keys).forEach(([key, value]) => kv.set(`${arch}.${key}`, value));
  const profile = ggufProfileFromHeader(kv, tensors);
  if (!profile) {
    throw new Error(`${arch} fixture is not a model`);
  }
  return profile;
}

const hybridLayers = (blocks: number): boolean[] => every(blocks, (i) => (i + 1) % 4 !== 0);
const swaLayers = (blocks: number): boolean[] => every(blocks, (i) => (i + 1) % 6 !== 0);

const MIMO = model(
  'qwen35',
  {
    block_count: 32,
    context_length: 262144,
    embedding_length: 4096,
    'attention.head_count': 16,
    'attention.head_count_kv': 4,
    'attention.key_length': 256,
    'attention.value_length': 256,
    'ssm.conv_kernel': 4,
    'ssm.state_size': 128,
    'ssm.group_count': 16,
    'ssm.inner_size': 4096,
    'attention.recurrent_layers': hybridLayers(32),
    full_attention_interval: 4,
  },
  { total: 9516533760, tokenEmbd: 1080688640, output: 1080688640 },
);

const GEMMA_12B = model(
  'gemma4',
  {
    block_count: 48,
    context_length: 262144,
    embedding_length: 3840,
    'attention.head_count': 16,
    'attention.head_count_kv': every(48, (i) => ((i + 1) % 6 === 0 ? 1 : 8)),
    'attention.key_length': 512,
    'attention.value_length': 512,
    'attention.sliding_window': 1024,
    'attention.shared_kv_layers': 0,
    'attention.sliding_window_pattern': swaLayers(48),
    'attention.key_length_swa': 256,
    'attention.value_length_swa': 256,
  },
  { total: 7203849728, tokenEmbd: 1069547520 },
);

const GEMMA_E4B = model(
  'gemma4',
  {
    block_count: 42,
    context_length: 131072,
    embedding_length: 2560,
    'attention.head_count': 8,
    'attention.head_count_kv': 2,
    'attention.key_length': 512,
    'attention.value_length': 512,
    'attention.sliding_window': 512,
    'attention.shared_kv_layers': 18,
    'attention.sliding_window_pattern': swaLayers(42),
    'attention.key_length_swa': 256,
    'attention.value_length_swa': 256,
  },
  { total: 4574984512, tokenEmbd: 713031680, perLayerEmbd: 1585446912 },
);

const MTP_GEMMA_12B = model(
  'gemma4-assistant',
  {
    block_count: 4,
    context_length: 262144,
    embedding_length: 1024,
    embedding_length_out: 3840,
    nextn_predict_layers: 4,
    'attention.head_count': 16,
    'attention.head_count_kv': [8, 8, 8, 1],
    'attention.key_length': 512,
    'attention.value_length': 512,
    'attention.sliding_window': 1024,
    'attention.shared_kv_layers': 4,
    'attention.sliding_window_pattern': [true, true, true, false],
    'attention.key_length_swa': 256,
    'attention.value_length_swa': 256,
  },
  { total: 237922432, tokenEmbd: 150994944, head: 80286848, headBlock: 3 },
);

const SWIFT_27B = model(
  'qwen35',
  {
    block_count: 65,
    context_length: 262144,
    embedding_length: 5120,
    nextn_predict_layers: 1,
    'attention.head_count': 24,
    'attention.head_count_kv': 4,
    'attention.key_length': 256,
    'attention.value_length': 256,
    'ssm.conv_kernel': 4,
    'ssm.state_size': 128,
    'ssm.group_count': 16,
    'ssm.inner_size': 6144,
    'attention.recurrent_layers': hybridLayers(65),
    full_attention_interval: 4,
  },
  { total: 25288065024, tokenEmbd: 1042944000, output: 1350860800, head: 351008768, headBlock: 64 },
);

describe('the VRAM estimate against measured loads', () => {
  interface MeasuredLoad {
    name: string;
    profile: GgufProfile;
    c: number;
    cache: string;
    mb: number;
    ub: number;
  }
  const load = (name: string, profile: GgufProfile, c: number, cache: string, mb: number, ub = 512): MeasuredLoad => ({
    name,
    profile,
    c,
    cache,
    mb,
    ub,
  });
  const LOADS: readonly MeasuredLoad[] = [
    load('MiMo', MIMO, 16384, 'q8_0', 8734),
    load('MiMo', MIMO, 32768, 'q8_0', 9086),
    load('MiMo', MIMO, 65536, 'q8_0', 9790),
    load('MiMo', MIMO, 131072, 'q8_0', 11198),
    load('MiMo', MIMO, 32768, 'f16', 9470),
    load('MiMo', MIMO, 65536, 'f16', 10526),
    load('MiMo', MIMO, 65536, 'q8_0', 9730, 256),
    load('MiMo', MIMO, 65536, 'q8_0', 9910, 1024),
    load('MiMo', MIMO, 65536, 'q8_0', 10150, 2048),
    load('Gemma 12B', GEMMA_12B, 16384, 'q8_0', 7630),
    load('Gemma 12B', GEMMA_12B, 32768, 'q8_0', 7782),
    load('Gemma 12B', GEMMA_12B, 65536, 'q8_0', 8140),
    load('Gemma 12B', GEMMA_12B, 131072, 'q8_0', 8876),
    load('Gemma 12B', GEMMA_12B, 32768, 'f16', 8246),
    load('Gemma 12B', GEMMA_12B, 65536, 'f16', 8790),
    load('Gemma 12B', GEMMA_12B, 65536, 'q8_0', 8042, 256),
    load('Gemma 12B', GEMMA_12B, 65536, 'q8_0', 8358, 1024),
    load('Gemma 12B', GEMMA_12B, 65536, 'q8_0', 8906, 2048),
    load('Gemma E4B', GEMMA_E4B, 16384, 'q8_0', 3388),
    load('Gemma E4B', GEMMA_E4B, 65536, 'q8_0', 4036),
  ];
  const base = { cards: 1, embeddedHead: false };
  const estimate = ({ profile, c, cache, ub }: MeasuredLoad): number =>
    estimateProfileMb(profile, { ...base, c, ctk: cache, ctv: cache, ub });
  const within5Percent = (estimated: number, measured: number): void => {
    expect(Math.abs(estimated - measured) / measured).toBeLessThan(0.05);
  };

  it.each(LOADS)('$name at -c $c, $cache, -ub $ub is within 5 percent of $mb MiB', (measured) => {
    within5Percent(estimate(measured), measured.mb);
  });

  it('stays within 2 percent over the whole table, where the old constant was 19 to 113 percent high', () => {
    const worst = Math.max(...LOADS.map((measured) => Math.abs(estimate(measured) - measured.mb) / measured.mb));
    expect(worst).toBeLessThan(0.02);
  });

  it('holds with a companion MTP head on Gemma 12B', () => {
    within5Percent(
      estimateProfileMb(GEMMA_12B, {
        ...base,
        c: 65536,
        ctk: 'q8_0',
        ctv: 'q8_0',
        ub: 512,
        companionHeadBytes: MTP_GEMMA_12B.tensorBytes,
      }),
      8140 + 472,
    );
  });

  it('holds for the first card of Swift 27B on two cards', () => {
    const gpus: CudaGpuDevice[] = [
      { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 },
      { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 16303 },
    ];
    const firstCardMb = (flags: string): number => {
      const command = `llama-server -m a.gguf -ctk q8_0 -ctv q8_0 -dev CUDA0,CUDA1 ${flags}`;
      return estimateManagedLlamaVram(command, gpus, null, [], SWIFT_27B)?.[0]?.modelMb ?? 0;
    };
    within5Percent(firstCardMb('-c 262144 --tensor-split 36,12'), 24.97 * 1024);
    within5Percent(firstCardMb('-c 131072 --tensor-split 32,16'), 19.5 * 1024);
  });

  it('reads the facts the formula was fitted on from each header', () => {
    expect(MIMO).toMatchObject({ fullKeys: 8192, swaKeys: 0, recurrentStateBytes: 52690944, hostBytes: 1080688640 });
    expect(MIMO.tensorBytes - MIMO.hostBytes).toBe(8435845120);
    expect(GEMMA_12B).toMatchObject({ fullKeys: 4096, maxFullKey: 512, swaKeys: 81920, hostBytes: 0, slidingWindow: 1024 });
    expect(GEMMA_E4B).toMatchObject({ fullKeys: 4096, maxFullKey: 1024, swaKeys: 10240, hostBytes: 1585446912 });
    expect(SWIFT_27B).toMatchObject({ nextnLayers: 1, fullKeys: 16384, recurrentStateBytes: 156893184, headBytes: 351008768 });
    expect(MTP_GEMMA_12B).toMatchObject({ embeddingOut: 3840, nextnLayers: 4 });
  });
});

describe('a sliding window with no pattern array', () => {
  const header = (arch: string, keys: Record<string, GgufValue>): GgufProfile => {
    const kv = new Map<string, GgufValue>([['general.architecture', arch]]);
    Object.entries({ block_count: 12, embedding_length: 1024, 'attention.head_count': 4, ...keys }).forEach(([key, value]) =>
      kv.set(`${arch}.${key}`, value),
    );
    const profile = ggufProfileFromHeader(kv, [{ name: 'blk.0.attn_q.weight', bytes: MIB }]);
    if (!profile) {
      throw new Error('not a model');
    }
    return profile;
  };
  const SWA = { 'attention.sliding_window': 512 };

  it('takes its period from upstream: five of every six layers on Gemma 3', () => {
    expect(header('gemma3', SWA)).toMatchObject({ swaKeys: 10 * 4 * 256, fullKeys: 2 * 4 * 256 });
  });

  it('starts with the full layer where upstream says dense first', () => {
    const laguna = header('laguna', SWA);
    expect(laguna).toMatchObject({ swaKeys: 9 * 4 * 256, fullKeys: 3 * 4 * 256 });
  });

  it('prefers a period in the header', () => {
    expect(header('gemma3', { ...SWA, 'attention.sliding_window_pattern': 2 })).toMatchObject({
      swaKeys: 6 * 4 * 256,
      fullKeys: 6 * 4 * 256,
    });
  });

  it('counts all layers as full for an architecture it does not know, or with no window', () => {
    expect(header('unknown', SWA)).toMatchObject({ swaKeys: 0, fullKeys: 12 * 4 * 256 });
    expect(header('gemma3', {})).toMatchObject({ swaKeys: 0, fullKeys: 12 * 4 * 256 });
  });
});
