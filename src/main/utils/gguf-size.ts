import { promises as fs } from 'node:fs';

const SPLIT_GGUF_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** A model's weights on disk. ``-m`` names only the first shard of a split GGUF, so all are counted. */
export async function ggufBytesOnDisk(file: string): Promise<number> {
  const split = SPLIT_GGUF_RE.exec(file);
  if (!split) {
    return (await fs.stat(file)).size;
  }
  const total = split[2] as string;
  const prefix = file.slice(0, split.index);
  const shards = Array.from(
    { length: Number.parseInt(total, 10) },
    (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`,
  );
  const stats = await Promise.all(shards.map((shard) => fs.stat(shard)));
  return stats.reduce((sum, stat) => sum + stat.size, 0);
}
