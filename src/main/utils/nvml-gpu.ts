import * as koffi from 'koffi';

/**
 * NVIDIA live GPU stats via NVML (nvml.dll), a flat C API. Provides per-GPU
 * utilization and VRAM used/total for every NVIDIA adapter — including
 * secondary cards that systeminformation leaves blank. Loaded in-process
 * (no child process spawn). Returns an empty map on non-Windows, if nvml.dll
 * is missing, or on any failure (never throws).
 *
 * Keyed by normalized model name so health.ts can merge onto the DXGI list.
 */

export interface NvmlGpuStats {
  utilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
}

const NVML_SUCCESS = 0;
const NVML_DEVICE_NAME_BUFFER = 96; // NVML_DEVICE_NAME_BUFFER_SIZE
const NVML_MEMORY_SIZE = 24; // three uint64: total, used, free
const NVML_UTIL_SIZE = 8; // two uint32: gpu, memory

let initialized = false;
let lib: koffi.LibraryHandle;
let nvmlInit: () => number;
let nvmlShutdown: () => number;
let nvmlDeviceGetCount: (count: unknown) => number;
let nvmlDeviceGetHandleByIndex: (index: number, handle: unknown) => number;
let nvmlDeviceGetName: (handle: bigint, name: unknown, length: number) => number;
let nvmlDeviceGetMemoryInfo: (handle: bigint, memory: unknown) => number;
let nvmlDeviceGetUtilizationRates: (handle: bigint, util: unknown) => number;

function init(): boolean {
  try {
    lib = koffi.load('nvml.dll');
    nvmlInit = lib.func('int32 nvmlInit_v2()');
    nvmlShutdown = lib.func('int32 nvmlShutdown()');
    nvmlDeviceGetCount = lib.func('int32 nvmlDeviceGetCount_v2(void *count)');
    nvmlDeviceGetHandleByIndex = lib.func('int32 nvmlDeviceGetHandleByIndex_v2(uint32 index, void *handle)');
    nvmlDeviceGetName = lib.func('int32 nvmlDeviceGetName(void *handle, void *name, uint32 length)');
    nvmlDeviceGetMemoryInfo = lib.func('int32 nvmlDeviceGetMemoryInfo(void *handle, void *memory)');
    nvmlDeviceGetUtilizationRates = lib.func('int32 nvmlDeviceGetUtilizationRates(void *handle, void *util)');
    if (nvmlInit() !== NVML_SUCCESS) {
      initialized = false;
      return false;
    }
    initialized = true;
    return true;
  } catch {
    initialized = false;
    return false;
  }
}

function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Returns live stats keyed by normalized model name, or an empty map on failure. */
export function getNvidiaStats(): Map<string, NvmlGpuStats> {
  if (process.platform !== 'win32') return new Map();
  try {
    if (!initialized && !init()) return new Map();

    const countSlot = koffi.alloc('uint32', 1);
    if (nvmlDeviceGetCount(countSlot) !== NVML_SUCCESS) return new Map();
    const count = koffi.decode(countSlot, 'uint32') as number;

    const out = new Map<string, NvmlGpuStats>();
    for (let i = 0; i < count; i++) {
      const handleSlot = koffi.alloc('void *', 1);
      if (nvmlDeviceGetHandleByIndex(i, handleSlot) !== NVML_SUCCESS) continue;
      const handle = koffi.decode(handleSlot, 'void *') as bigint;
      if (!handle) continue;

      const nameBuf = Buffer.alloc(NVML_DEVICE_NAME_BUFFER);
      const nameOk = nvmlDeviceGetName(handle, nameBuf, NVML_DEVICE_NAME_BUFFER) === NVML_SUCCESS;
      const model = nameOk ? nameBuf.toString('ascii', 0, nameBuf.indexOf(0)).trim() : '';

      const memBuf = Buffer.alloc(NVML_MEMORY_SIZE);
      const memOk = nvmlDeviceGetMemoryInfo(handle, memBuf) === NVML_SUCCESS;
      const total = memOk ? Number(memBuf.readBigUInt64LE(0)) : 0;
      const used = memOk ? Number(memBuf.readBigUInt64LE(8)) : 0;

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

/**
 * NVIDIA GPUs in CUDA / NVML index order (same ordinals llama-server ``-dev CUDA{n}`` uses).
 * Empty on non-Windows, missing NVML, or any failure.
 */
export function listNvidiaCudaGpus(): Array<{ cudaIndex: number; model: string; memoryTotalMb: number }> {
  if (process.platform !== 'win32') return [];
  try {
    if (!initialized && !init()) return [];

    const countSlot = koffi.alloc('uint32', 1);
    if (nvmlDeviceGetCount(countSlot) !== NVML_SUCCESS) return [];
    const count = koffi.decode(countSlot, 'uint32') as number;

    const out: Array<{ cudaIndex: number; model: string; memoryTotalMb: number }> = [];
    for (let i = 0; i < count; i++) {
      const handleSlot = koffi.alloc('void *', 1);
      if (nvmlDeviceGetHandleByIndex(i, handleSlot) !== NVML_SUCCESS) continue;
      const handle = koffi.decode(handleSlot, 'void *') as bigint;
      if (!handle) continue;

      const nameBuf = Buffer.alloc(NVML_DEVICE_NAME_BUFFER);
      const nameOk = nvmlDeviceGetName(handle, nameBuf, NVML_DEVICE_NAME_BUFFER) === NVML_SUCCESS;
      const model = nameOk ? nameBuf.toString('ascii', 0, nameBuf.indexOf(0)).trim() : '';

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
