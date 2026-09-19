import * as koffi from 'koffi';

/**
 * AMD live GPU stats via ADL (atiadlxx.dll), a flat C API. ADL is
 * display-centric: only adapters driving a display report as "active" and
 * expose utilization (ADL2_Overdrive5_CurrentActivity_Get). An integrated
 * Radeon that is not the primary display adapter (e.g. behind a discrete
 * NVIDIA GPU) will be inactive and yield no live data — in that case the
 * AMD card falls back to DXGI model + total VRAM only.
 *
 * VRAM "used" is not reported here: ADL's Adapter_MemoryInfo gives total only,
 * and DXGI QueryVideoMemoryInfo is unreliable on some systems. So AMD cards
 * show total VRAM (from DXGI) and, when active, GPU utilization.
 *
 * Returns an array of { utilPercent } for active AMD adapters in ADL order,
 * to be overlaid onto the DXGI AMD adapters by ordinal. Empty on non-Windows
 * or any failure (never throws).
 */

export interface AdlGpuStats {
  utilPercent: number | null;
}

const ADL_SUCCESS = 0;
const ADLPMACTIVITY_SIZE = 28; // 7 x int32; iActivityPercent at offset 12
/** Out-param slots are GC-managed Buffers (``koffi.alloc`` is an unfreed ``calloc``). */
const INT32_SIZE = 4;
const POINTER_SIZE = 8;

let initialized = false;
let context: bigint | null = null;
let ucrtMalloc: (size: number) => bigint;
let mallocCb: bigint | null = null;
let lib: koffi.LibraryHandle;
let ADL2_Main_Control_Create: (cb: bigint, enumConnected: number, ctx: unknown) => number;
let ADL2_Main_Control_Destroy: (ctx: bigint) => number;
let ADL2_Adapter_NumberOfAdapters_Get: (ctx: bigint, num: unknown) => number;
let ADL2_Adapter_Active_Get: (ctx: bigint, index: number, status: unknown) => number;
let ADL2_Overdrive5_CurrentActivity_Get: (ctx: bigint, index: number, activity: unknown) => number;

/**
 * Set up the ADL malloc callback once and reuse it across init/shutdown cycles.
 * The callback is routed through the Universal CRT (ucrtbase.dll malloc) so
 * ADL's internal free() matches our allocation. koffi callback slots are
 * limited, so registering on every init would leak them over time.
 */
function ensureCallback(): boolean {
  if (mallocCb !== null) return true;
  try {
    const ucrt = koffi.load('ucrtbase.dll');
    ucrtMalloc = ucrt.func('void *malloc(uint64 size)') as (size: number) => bigint;
    const MallocCb = koffi.proto('void *AdlMallocCb(int32 size)');
    mallocCb = koffi.register((size: number) => ucrtMalloc(size), koffi.pointer(MallocCb));
    return true;
  } catch {
    return false;
  }
}

function init(): boolean {
  if (!ensureCallback()) {
    initialized = false;
    return false;
  }
  try {
    lib = koffi.load('atiadlxx.dll');
    ADL2_Main_Control_Create = lib.func('int32 ADL2_Main_Control_Create(void *cb, int32 enumConnected, void *context)') as typeof ADL2_Main_Control_Create;
    ADL2_Main_Control_Destroy = lib.func('int32 ADL2_Main_Control_Destroy(void *context)') as typeof ADL2_Main_Control_Destroy;
    ADL2_Adapter_NumberOfAdapters_Get = lib.func('int32 ADL2_Adapter_NumberOfAdapters_Get(void *context, void *num)') as typeof ADL2_Adapter_NumberOfAdapters_Get;
    ADL2_Adapter_Active_Get = lib.func('int32 ADL2_Adapter_Active_Get(void *context, int32 index, void *status)') as typeof ADL2_Adapter_Active_Get;
    ADL2_Overdrive5_CurrentActivity_Get = lib.func('int32 ADL2_Overdrive5_CurrentActivity_Get(void *context, int32 index, void *activity)') as typeof ADL2_Overdrive5_CurrentActivity_Get;

    const ctxSlot = Buffer.alloc(POINTER_SIZE);
    if (ADL2_Main_Control_Create(mallocCb as bigint, 0, ctxSlot) !== ADL_SUCCESS) {
      initialized = false;
      return false;
    }
    context = koffi.decode(ctxSlot, 'void *') as bigint;
    initialized = true;
    return true;
  } catch {
    initialized = false;
    return false;
  }
}

/** Live stats for active AMD adapters, in ADL order. Empty on failure. */
export function getAmdStats(): AdlGpuStats[] {
  if (process.platform !== 'win32') return [];
  try {
    if (!initialized && !init()) return [];
    if (context === null) return [];

    const numSlot = Buffer.alloc(INT32_SIZE);
    if (ADL2_Adapter_NumberOfAdapters_Get(context, numSlot) !== ADL_SUCCESS) return [];
    const count = koffi.decode(numSlot, 'int32') as number;

    const out: AdlGpuStats[] = [];
    for (let i = 0; i < count; i++) {
      const activeSlot = Buffer.alloc(INT32_SIZE);
      if (ADL2_Adapter_Active_Get(context, i, activeSlot) !== ADL_SUCCESS) continue;
      if ((koffi.decode(activeSlot, 'int32') as number) === 0) continue; // inactive

      const activity = Buffer.alloc(ADLPMACTIVITY_SIZE);
      if (ADL2_Overdrive5_CurrentActivity_Get(context, i, activity) !== ADL_SUCCESS) continue;
      const util = activity.readInt32LE(12); // iActivityPercent
      out.push({ utilPercent: util >= 0 && util <= 100 ? util : null });
    }
    return out;
  } catch {
    return [];
  }
}

/** Release the ADL session (called when live stats are disabled). */
export function shutdownAdl(): void {
  if (initialized && context !== null) {
    try {
      ADL2_Main_Control_Destroy(context);
    } catch {
      // ignore
    }
  }
  initialized = false;
  context = null;
}
