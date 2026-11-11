import { promises as fs } from 'node:fs';
import type { GgufProfile } from '../../shared';
import { ggufShardPaths } from './gguf-size';

/** Tokenizer arrays put most headers at 10 to 16 MiB; later shards hold only a few KiB. */
const FIRST_READ_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024 * 1024;
const MAX_KEY_COUNT = 65_536;
const MAX_TENSOR_COUNT = 262_144;
const MAX_TENSOR_DIMS = 8;
const MAX_KEPT_STRING_BYTES = 256;
/** Long enough for any per-layer array; a tokenizer's token types are not worth keeping. */
const MAX_KEPT_ARRAY_LENGTH = 2048;
const MAX_BLOCK_COUNT = 4096;
const DEFAULT_ALIGNMENT = 32;

const GGUF_STRING = 8;
const GGUF_ARRAY = 9;
const SCALAR_BYTES: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

export type GgufValue = number | boolean | string | (number | boolean)[] | null;

export interface GgufTensorSize {
  name: string;
  bytes: number;
}

interface GgufHeader {
  kv: Map<string, GgufValue>;
  tensors: GgufTensorSize[];
}

/** The header runs past the bytes read so far. */
class HeaderCutOff extends Error {}

class HeaderCursor {
  pos = 0;

  constructor(private readonly buf: Buffer) {}

  private take(bytes: number): number {
    if (this.pos + bytes > this.buf.length) {
      throw new HeaderCutOff();
    }
    const at = this.pos;
    this.pos += bytes;
    return at;
  }

  skip(bytes: number): void {
    this.take(bytes);
  }

  u32(): number {
    return this.buf.readUInt32LE(this.take(4));
  }

  u64(): number {
    return Number(this.buf.readBigUInt64LE(this.take(8)));
  }

  text(bytes: number): string {
    const at = this.take(bytes);
    return this.buf.toString('utf8', at, at + bytes);
  }

  scalar(type: number): number | boolean {
    const at = this.take(SCALAR_BYTES[type] ?? 0);
    switch (type) {
      case 0:
        return this.buf.readUInt8(at);
      case 1:
        return this.buf.readInt8(at);
      case 2:
        return this.buf.readUInt16LE(at);
      case 3:
        return this.buf.readInt16LE(at);
      case 4:
        return this.buf.readUInt32LE(at);
      case 5:
        return this.buf.readInt32LE(at);
      case 6:
        return this.buf.readFloatLE(at);
      case 7:
        return this.buf.readUInt8(at) !== 0;
      case 10:
        return Number(this.buf.readBigUInt64LE(at));
      case 11:
        return Number(this.buf.readBigInt64LE(at));
      case 12:
        return this.buf.readDoubleLE(at);
      default:
        throw new Error(`Unknown GGUF value type ${type}.`);
    }
  }
}

/** A value, or ``null`` for what no one here reads: long strings, string arrays, long arrays. */
function readValue(c: HeaderCursor, type: number): GgufValue {
  if (type === GGUF_STRING) {
    const bytes = c.u64();
    if (bytes > MAX_KEPT_STRING_BYTES) {
      c.skip(bytes);
      return null;
    }
    return c.text(bytes);
  }
  if (type !== GGUF_ARRAY) {
    return c.scalar(type);
  }
  const elementType = c.u32();
  const count = c.u64();
  if (elementType === GGUF_STRING) {
    for (let i = 0; i < count; i++) {
      c.skip(c.u64());
    }
    return null;
  }
  const elementBytes = SCALAR_BYTES[elementType];
  if (!elementBytes) {
    throw new Error(`Unknown GGUF array element type ${elementType}.`);
  }
  if (count > MAX_KEPT_ARRAY_LENGTH) {
    c.skip(count * elementBytes);
    return null;
  }
  return Array.from({ length: count }, () => c.scalar(elementType));
}

/** Throws {@link HeaderCutOff} when ``buf`` ends inside the header, anything else when it isn't a GGUF. */
function parseGgufHeader(buf: Buffer, fileBytes: number): GgufHeader {
  if (buf.toString('latin1', 0, 4) !== 'GGUF') {
    throw new Error('Not a GGUF file.');
  }
  const c = new HeaderCursor(buf);
  c.skip(4);
  const version = c.u32();
  const tensorCount = c.u64();
  const keyCount = c.u64();
  if (version < 2 || version > 3 || tensorCount > MAX_TENSOR_COUNT || keyCount > MAX_KEY_COUNT) {
    throw new Error('Unsupported GGUF header.');
  }
  const kv = new Map<string, GgufValue>();
  for (let i = 0; i < keyCount; i++) {
    const key = c.text(c.u64());
    kv.set(key, readValue(c, c.u32()));
  }
  const placed: { name: string; offset: number }[] = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = c.text(c.u64());
    const dims = c.u32();
    if (dims > MAX_TENSOR_DIMS) {
      throw new Error('Unsupported GGUF tensor.');
    }
    c.skip(dims * 8 + 4);
    placed.push({ name, offset: c.u64() });
  }
  const alignment = kv.get('general.alignment');
  const align = typeof alignment === 'number' && alignment > 0 ? alignment : DEFAULT_ALIGNMENT;
  const dataBytes = fileBytes - Math.ceil(c.pos / align) * align;
  // Sizes from offsets hold for every tensor type, including ones not known here.
  placed.sort((a, b) => a.offset - b.offset);
  const tensors = placed.map(({ name, offset }, i) => ({ name, bytes: (placed[i + 1]?.offset ?? dataBytes) - offset }));
  if (dataBytes < 0 || tensors.some((t) => t.bytes < 0)) {
    throw new Error('GGUF tensors run past the end of the file.');
  }
  return { kv, tensors };
}

async function readGgufHeader(file: string): Promise<GgufHeader> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const limit = Math.min(size, MAX_HEADER_BYTES);
    for (let length = Math.min(FIRST_READ_BYTES, limit); ; length = Math.min(length * 4, limit)) {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, 0);
      try {
        return parseGgufHeader(buf.subarray(0, bytesRead), size);
      } catch (err) {
        if (!(err instanceof HeaderCutOff) || length >= limit) {
          throw err;
        }
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Architectures whose sliding window repeats by a period set in upstream's code, with no pattern array in the
 * header (`llama_hparams::set_swa_pattern`). Read as all full attention, they plan far too small a context.
 */
const SWA_PERIODS: Readonly<Record<string, { period: number; denseFirst?: boolean }>> = {
  afmoe: { period: 4 },
  cohere2: { period: 4 },
  exaone4: { period: 4 },
  'exaone-moe': { period: 4 },
  gemma2: { period: 2 },
  gemma3: { period: 6 },
  gemma3n: { period: 5 },
  'gemma-embedding': { period: 6 },
  'gpt-oss': { period: 2 },
  laguna: { period: 4, denseFirst: true },
  llama4: { period: 4 },
  olmo2: { period: 4 },
  plamo3: { period: 8 },
  smallthinker: { period: 4, denseFirst: true },
};

function swaPeriodOf(
  arch: string,
  slidingWindow: number,
  scalarPattern: number,
): { period: number; denseFirst?: boolean } | null {
  if (slidingWindow <= 0) {
    return null;
  }
  const known = SWA_PERIODS[arch] ?? null;
  return scalarPattern > 0 ? { period: scalarPattern, denseFirst: known?.denseFirst } : known;
}

/** The profile fields, from a header's keys and tensor sizes. ``null`` when they don't describe a model. */
export function ggufProfileFromHeader(
  kv: ReadonlyMap<string, GgufValue>,
  tensors: readonly GgufTensorSize[],
): GgufProfile | null {
  const arch = kv.get('general.architecture');
  if (typeof arch !== 'string') {
    return null;
  }
  const value = (key: string): GgufValue | undefined => kv.get(`${arch}.${key}`);
  const num = (key: string, fallback = 0): number => {
    const v = value(key);
    return typeof v === 'number' ? v : fallback;
  };
  const list = (key: string): (number | boolean)[] | null => {
    const v = value(key);
    return Array.isArray(v) ? v : null;
  };

  const blocks = num('block_count');
  if (blocks <= 0 || blocks > MAX_BLOCK_COUNT) {
    return null;
  }
  const embedding = num('embedding_length');
  const headCounts = list('attention.head_count');
  const heads = headCounts ? Math.max(0, ...headCounts.map(Number)) : num('attention.head_count');
  const headLength = heads > 0 ? Math.floor(embedding / heads) : 0;
  const nextnLayers = num('nextn_predict_layers');
  const regularLayers = blocks - nextnLayers;
  const keyLength = num('attention.key_length', headLength);
  const valueLength = num('attention.value_length', headLength);
  const swaKeyLength = num('attention.key_length_swa', keyLength);
  const swaValueLength = num('attention.value_length_swa', valueLength);

  const headsKv = list('attention.head_count_kv');
  const headsKvAll = num('attention.head_count_kv', heads);
  const swaPattern = list('attention.sliding_window_pattern');
  const swaPeriod = swaPattern ? null : swaPeriodOf(arch, num('attention.sliding_window'), num('attention.sliding_window_pattern'));
  const isSwa = (il: number): boolean => {
    if (swaPattern) {
      return !!swaPattern[il];
    }
    if (!swaPeriod) {
      return false;
    }
    return swaPeriod.denseFirst ? il % swaPeriod.period !== 0 : il % swaPeriod.period < swaPeriod.period - 1;
  };
  const recurrentLayers = list('attention.recurrent_layers');
  const fullInterval = num('full_attention_interval');
  const isRecurrent = (il: number): boolean =>
    recurrentLayers ? !!recurrentLayers[il] : fullInterval > 0 && (il + 1) % fullInterval !== 0;
  // Layers from here on reuse the K/V of an earlier one.
  const ownKvLayers = blocks - num('attention.shared_kv_layers');

  let recurrentCount = 0;
  let fullKeys = 0;
  let fullValues = 0;
  let maxFullKey = 0;
  let swaKeys = 0;
  let swaValues = 0;
  for (let il = 0; il < regularLayers; il++) {
    if (isRecurrent(il)) {
      recurrentCount++;
    } else if (il < ownKvLayers) {
      const headKv = headsKv ? Number(headsKv[il] ?? 0) : headsKvAll;
      if (isSwa(il)) {
        swaKeys += headKv * swaKeyLength;
        swaValues += headKv * swaValueLength;
      } else {
        fullKeys += headKv * keyLength;
        fullValues += headKv * valueLength;
        maxFullKey = Math.max(maxFullKey, headKv * keyLength);
      }
    }
  }

  let tensorBytes = 0;
  let headBytes = 0;
  const sizes = new Map<string, number>();
  for (const { name, bytes } of tensors) {
    tensorBytes += bytes;
    sizes.set(name, bytes);
    const block = /^blk\.(\d+)\./.exec(name);
    if (block && Number(block[1]) >= regularLayers) {
      headBytes += bytes;
    }
  }
  const stateSize = num('ssm.state_size');
  const innerSize = num('ssm.inner_size');
  const convKernel = num('ssm.conv_kernel');
  const groupCount = num('ssm.group_count');
  const recurrentLayerBytes =
    ((convKernel > 0 ? convKernel - 1 : 0) * (innerSize + 2 * groupCount * stateSize) + stateSize * innerSize) * 4;

  return {
    contextTrain: num('context_length'),
    embeddingOut: num('embedding_length_out') || embedding,
    nextnLayers,
    tensorBytes,
    hostBytes:
      (sizes.get('per_layer_token_embd.weight') ?? 0) + (sizes.has('output.weight') ? (sizes.get('token_embd.weight') ?? 0) : 0),
    headBytes,
    recurrentStateBytes: recurrentCount * recurrentLayerBytes,
    fullKeys,
    fullValues,
    maxFullKey,
    swaKeys,
    swaValues,
    slidingWindow: num('attention.sliding_window'),
    cacheLengths: [...new Set([keyLength, valueLength, swaKeyLength, swaValueLength])],
  };
}

/**
 * What a model's header says about its memory, reading no tensor data: only a bounded part of each
 * file, and every shard of a split model. ``null`` for anything that isn't a readable model.
 */
export async function readGgufProfile(file: string): Promise<GgufProfile | null> {
  try {
    let kv: GgufHeader['kv'] | null = null;
    const tensors: GgufTensorSize[] = [];
    for (const shard of ggufShardPaths(file)) {
      const header = await readGgufHeader(shard);
      kv ??= header.kv;
      for (const tensor of header.tensors) {
        tensors.push(tensor);
      }
    }
    return kv && ggufProfileFromHeader(kv, tensors);
  } catch {
    return null;
  }
}
