import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLlamaServerHelp, type LlamaFlagCatalog } from '../shared/llama-run-command';
import { getManagedLlamaServerPath, getRuntimeBinDir } from './paths';

const HELP_TIMEOUT_MS = 20_000;
const HELP_MAX_BYTES = 4 * 1024 * 1024;

export type LlamaFlagCatalogResult = { ok: true; catalog: LlamaFlagCatalog } | { ok: false; error: string };

let cached: { fingerprint: string; catalog: LlamaFlagCatalog } | null = null;
let inFlight: { fingerprint: string; result: Promise<LlamaFlagCatalogResult> } | null = null;

function runManagedBinary(bin: string, arg: string): Promise<{ stdout: string; stderr: string }> {
  const runtimeBin = getRuntimeBinDir();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Thin llama-server builds load their libs from runtime/bin (see buildManagedLlamaSpawnEnv).
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${runtimeBin}${path.delimiter}${env.LD_LIBRARY_PATH}` : runtimeBin;
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${runtimeBin}${path.delimiter}${env.DYLD_LIBRARY_PATH}` : runtimeBin;
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [arg],
      { timeout: HELP_TIMEOUT_MS, maxBuffer: HELP_MAX_BYTES, windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function versionFromOutput(text: string): string | null {
  const m = /^version:\s*(.+)$/m.exec(text);
  return m ? (m[1] as string).trim() : null;
}

async function readCatalog(bin: string): Promise<LlamaFlagCatalogResult> {
  try {
    const help = await runManagedBinary(bin, '--help');
    const catalog = parseLlamaServerHelp(help.stdout, null);
    if (!catalog.flags.length) {
      return { ok: false, error: 'llama-server --help listed no options.' };
    }
    const version = await runManagedBinary(bin, '--version').catch(() => null);
    catalog.version = version ? versionFromOutput(`${version.stdout}\n${version.stderr}`) : null;
    return { ok: true, catalog };
  } catch (e) {
    return { ok: false, error: `Could not read llama-server options: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Options of the installed managed ``llama-server``, read from its own ``--help``. Builds gain and
 * drop flags, so this is the only reliable list. Cached until the binary changes on disk.
 */
export async function getLlamaServerFlagCatalog(): Promise<LlamaFlagCatalogResult> {
  const bin = getManagedLlamaServerPath();
  if (!bin) {
    return { ok: false, error: 'llama-server is not installed.' };
  }
  let fingerprint: string;
  try {
    const stat = await fs.stat(bin);
    fingerprint = `${bin}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return { ok: false, error: 'llama-server is not installed.' };
  }
  if (cached?.fingerprint === fingerprint) {
    return { ok: true, catalog: cached.catalog };
  }
  if (inFlight?.fingerprint === fingerprint) {
    return inFlight.result;
  }
  const result = readCatalog(bin).then((res) => {
    if (res.ok) {
      cached = { fingerprint, catalog: res.catalog };
    }
    return res;
  });
  inFlight = { fingerprint, result };
  try {
    return await result;
  } finally {
    if (inFlight?.result === result) {
      inFlight = null;
    }
  }
}
