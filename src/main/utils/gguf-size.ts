import { promises as fs } from 'node:fs';

const SPLIT_GGUF_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** Every file of a model. ``-m`` names only the first shard of a split GGUF. */
export function ggufShardPaths(file: string): string[] {
  const split = SPLIT_GGUF_RE.exec(file);
  if (!split) {
    return [file];
  }
  const total = split[2] as string;
  const prefix = file.slice(0, split.index);
  return Array.from(
    { length: Number.parseInt(total, 10) },
    (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`,
  );
}

/** A model's weights on disk, across all its shards. */
export async function ggufBytesOnDisk(file: string): Promise<number> {
  const stats = await Promise.all(ggufShardPaths(file).map((shard) => fs.stat(shard)));
  return stats.reduce((sum, stat) => sum + stat.size, 0);
}
