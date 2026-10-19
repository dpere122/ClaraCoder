import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as koffi from 'koffi';

/**
 * NVIDIA live GPU stats via NVML, a flat C API. Provides per-GPU utilization
 * and VRAM used/total for every NVIDIA adapter — including secondary cards
 * that systeminformation leaves blank. Loaded in-process (no child process
 * spawn) from ``nvml.dll`` on Windows or ``libnvidia-ml.so.1`` on Linux.
 *
 * GPU inventory for llama.cpp offload radios also falls back to ``nvidia-smi``
 * when NVML cannot be loaded (common in packaged Linux builds whose rpath
 * hides the driver library). Returns empty on missing driver or any failure
 * (never throws).
 *
 * Keyed by normalized model name so health.ts can merge onto the DXGI list.
 */

export interface NvmlGpuStats {
  utilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
}

export interface NvidiaCudaGpu {
  cudaIndex: number;
  model: string;
  memoryTotalMb: number;
}

const NVML_SUCCESS = 0;
const NVML_DEVICE_NAME_BUFFER = 96; // NVML_DEVICE_NAME_BUFFER_SIZE
const NVML_MEMORY_SIZE = 24; // nvmlMemory_t: three uint64 in the order total, free, used
const NVML_UTIL_SIZE = 8; // two uint32: gpu, memory

/**
 * Decode an `nvmlMemory_t` buffer (bytes). Field order is total, free, used: reading offset 8
 * as "used" reports free VRAM instead, e.g. 29 GB "used" on an idle 32 GB card.
 */
export function decodeNvmlMemory(buf: Buffer): { total: number; free: number; used: number } {
  return {
    total: Number(buf.readBigUInt64LE(0)),
    free: Number(buf.readBigUInt64LE(8)),
    used: Number(buf.readBigUInt64LE(16)),
  };
}
const NVIDIA_SMI_TIMEOUT_MS = 8_000;
/**
 * Out-param slots are GC-managed ``Buffer``s, not ``koffi.alloc`` — koffi.alloc is a raw
 * ``calloc`` that is never freed, and these helpers run on every health tick.
 */
const UINT32_SIZE = 4;
const POINTER_SIZE = 8;

let initialized = false;
let lib: koffi.LibraryHandle;
let nvmlInit: () => number;
let nvmlShutdown: () => number;
let nvmlDeviceGetCount: (count: unknown) => number;
let nvmlDeviceGetHandleByIndex: (index: number, handle: unknown) => number;
let nvmlDeviceGetName: (handle: bigint, name: unknown, length: number) => number;
let nvmlDeviceGetMemoryInfo: (handle: bigint, memory: unknown) => number;
let nvmlDeviceGetUtilizationRates: (handle: bigint, util: unknown) => number;

/** Driver library names / paths to try with koffi (dlopen / LoadLibrary). */
export function nvmlLibraryCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return ['nvml.dll'];
  }
  if (platform === 'linux') {
    return [
      'libnvidia-ml.so.1',
      'libnvidia-ml.so',
      '/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1',
      '/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-ml.so.1',
      '/usr/lib64/libnvidia-ml.so.1',
      '/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.1',
      '/usr/local/cuda/lib64/libnvidia-ml.so.1',
    ];
  }
  return [];
}

function bindNvml(handle: koffi.LibraryHandle): boolean {
  nvmlInit = handle.func('int32 nvmlInit_v2()');
  nvmlShutdown = handle.func('int32 nvmlShutdown()');
  nvmlDeviceGetCount = handle.func('int32 nvmlDeviceGetCount_v2(void *count)');
  nvmlDeviceGetHandleByIndex = handle.func('int32 nvmlDeviceGetHandleByIndex_v2(uint32 index, void *handle)');
  nvmlDeviceGetName = handle.func('int32 nvmlDeviceGetName(void *handle, void *name, uint32 length)');
  nvmlDeviceGetMemoryInfo = handle.func('int32 nvmlDeviceGetMemoryInfo(void *handle, void *memory)');
  nvmlDeviceGetUtilizationRates = handle.func('int32 nvmlDeviceGetUtilizationRates(void *handle, void *util)');
  return nvmlInit() === NVML_SUCCESS;
}

function init(): boolean {
  const candidates = nvmlLibraryCandidates();
  if (!candidates.length) {
    initialized = false;
    return false;
  }
  for (const name of candidates) {
    if ((name.includes('/') || name.includes('\\')) && !existsSync(name)) {
      continue;
    }
    try {
      lib = koffi.load(name);
      if (!bindNvml(lib)) {
        continue;
      }
      initialized = true;
      return true;
    } catch {
      // try next candidate
    }
  }
  initialized = false;
  return false;
}

function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\s+/g, ' ').trim();
}

function nvmlNameFromBuffer(nameBuf: Buffer): string {
  const end = nameBuf.indexOf(0);
  return nameBuf.toString('utf8', 0, end < 0 ? nameBuf.length : end).trim();
}

/** Parse ``nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits``. */
export function parseNvidiaSmiGpuList(csv: string): NvidiaCudaGpu[] {
  const out: NvidiaCudaGpu[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const firstComma = line.indexOf(',');
    const lastComma = line.lastIndexOf(',');
    if (firstComma <= 0 || lastComma <= firstComma) {
      continue;
    }
    const cudaIndex = Number.parseInt(line.slice(0, firstComma).trim(), 10);
    const model = line.slice(firstComma + 1, lastComma).trim();
    const memoryTotalMb = Number.parseInt(line.slice(lastComma + 1).trim(), 10);
    if (!Number.isFinite(cudaIndex) || cudaIndex < 0 || !model) {
      continue;
    }
    if (!Number.isFinite(memoryTotalMb) || memoryTotalMb < 1024) {
      continue;
    }
    out.push({ cudaIndex, model, memoryTotalMb });
  }
  return out;
}

function listNvidiaCudaGpusFromSmi(): NvidiaCudaGpu[] {
  try {
    const csv = execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: NVIDIA_SMI_TIMEOUT_MS, windowsHide: true },
    );
    return parseNvidiaSmiGpuList(csv);
  } catch {
    return [];
  }
}

/** Returns live stats keyed by normalized model name, or an empty map on failure. */
export function getNvidiaStats(): Map<string, NvmlGpuStats> {
  try {
    if (!initialized && !init()) return new Map();

    const countSlot = Buffer.alloc(UINT32_SIZE);
    if (nvmlDeviceGetCount(countSlot) !== NVML_SUCCESS) return new Map();
    const count = koffi.decode(countSlot, 'uint32') as number;

    const out = new Map<string, NvmlGpuStats>();
    for (let i = 0; i < count; i++) {
      const handleSlot = Buffer.alloc(POINTER_SIZE);
      if (nvmlDeviceGetHandleByIndex(i, handleSlot) !== NVML_SUCCESS) continue;
      const handle = koffi.decode(handleSlot, 'void *') as bigint;
      if (!handle) continue;

      const nameBuf = Buffer.alloc(NVML_DEVICE_NAME_BUFFER);
      const nameOk = nvmlDeviceGetName(handle, nameBuf, NVML_DEVICE_NAME_BUFFER) === NVML_SUCCESS;
      const model = nameOk ? nvmlNameFromBuffer(nameBuf) : '';

      const memBuf = Buffer.alloc(NVML_MEMORY_SIZE);
      const memOk = nvmlDeviceGetMemoryInfo(handle, memBuf) === NVML_SUCCESS;
      const { total, used } = memOk ? decodeNvmlMemory(memBuf) : { total: 0, used: 0 };

      const utilBuf = Buffer.alloc(NVML_UTIL_SIZE);
      const utilOk = nvmlDeviceGetUtilizationRates(handle, utilBuf) === NVML_SUCCESS;
      const gpuUtil = utilOk ? utilBuf.readUInt32LE(0) : null;

      if (model) {
        out.set(normalizeModel(model), {
          utilPercent: gpuUtil,
          memoryUsedMb: memOk ? Math.round(used / 1048576) : null,
          memoryTotalMb: memOk && total > 0 ? Math.round(total / 1048576) : null,
        });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function listNvidiaCudaGpusFromNvml(): NvidiaCudaGpu[] {
  try {
    if (!initialized && !init()) return [];

    const countSlot = Buffer.alloc(UINT32_SIZE);
    if (nvmlDeviceGetCount(countSlot) !== NVML_SUCCESS) return [];
    const count = koffi.decode(countSlot, 'uint32') as number;

    const out: NvidiaCudaGpu[] = [];
    for (let i = 0; i < count; i++) {
      const handleSlot = Buffer.alloc(POINTER_SIZE);
      if (nvmlDeviceGetHandleByIndex(i, handleSlot) !== NVML_SUCCESS) continue;
      const handle = koffi.decode(handleSlot, 'void *') as bigint;
      if (!handle) continue;

      const nameBuf = Buffer.alloc(NVML_DEVICE_NAME_BUFFER);
      const nameOk = nvmlDeviceGetName(handle, nameBuf, NVML_DEVICE_NAME_BUFFER) === NVML_SUCCESS;
      const model = nameOk ? nvmlNameFromBuffer(nameBuf) : '';

      const memBuf = Buffer.alloc(NVML_MEMORY_SIZE);
      const memOk = nvmlDeviceGetMemoryInfo(handle, memBuf) === NVML_SUCCESS;
      const total = memOk ? Number(memBuf.readBigUInt64LE(0)) : 0;
      const memoryTotalMb = memOk && total > 0 ? Math.round(total / 1048576) : 0;
      if (!model || memoryTotalMb < 1024) continue;
      out.push({ cudaIndex: i, model, memoryTotalMb });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * NVIDIA GPUs in CUDA / NVML index order (same ordinals llama-server ``-dev CUDA{n}`` uses).
 * Empty on missing NVML / nvidia-smi, or any failure.
 */
export function listNvidiaCudaGpus(): NvidiaCudaGpu[] {
  const fromNvml = listNvidiaCudaGpusFromNvml();
  if (fromNvml.length) {
    return fromNvml;
  }
  return listNvidiaCudaGpusFromSmi();
}

/** Release the NVML session (called when live stats are disabled). */
export function shutdownNvml(): void {
  if (initialized) {
    try {
      nvmlShutdown();
    } catch {
      // ignore
    }
    initialized = false;
  }
}
