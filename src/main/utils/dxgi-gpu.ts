import * as koffi from 'koffi';
import type { GpuInfo } from '../../shared';

/** DXGI adapter info, extended with the PCI vendor id used to route to a vendor pipeline. */
export interface DxgiGpuInfo extends GpuInfo {
  vendorId: number | null;
}

export const NVIDIA_VENDOR_ID = 0x10de;
export const AMD_VENDOR_ID = 0x1002;

/**
 * Enumerate DXGI adapters on Windows to get each GPU's model, PCI vendor id,
 * and dedicated VRAM total, in-process (no child process spawn, unlike
 * systeminformation). Live utilization / VRAM usage are not collected here;
 * vendor pipelines (NVML for NVIDIA, ADL for AMD) overlay those in health.ts.
 *
 * Returns [] on non-Windows or on any failure (never throws).
 */

let initialized = false;
let lib: koffi.LibraryHandle;
let CreateDXGIFactory1: (riid: unknown, ppFactory: unknown) => number;
let EnumAdapters1Type: koffi.TypeObject;
let GetDescType: koffi.TypeObject;
let ReleaseType: koffi.TypeObject;
let iidFactory1: Buffer;

// x64 COM vtable indices (see https://learn.microsoft.com/en-us/windows/win32/api/dxgi/)
const VT_RELEASE = 2;
const VT_GET_DESC = 8; // IDXGIAdapter::GetDesc
const VT_ENUM_ADAPTERS1 = 12; // IDXGIFactory1::EnumAdapters1

// DXGI_ADAPTER_DESC layout (x64, 304 bytes): Description[128] (WCHAR, 256 bytes),
// VendorId/DeviceId/SubSysId/Revision (4x uint32 = 16 bytes), then three SIZE_T (8 bytes each)
// and LUID (8 bytes). DedicatedVideoMemory sits at byte offset 272.
const DESC_SIZE = 304;
const DESC_DESCRIPTION_BYTES = 256;
const DESC_VENDOR_ID_OFFSET = 256;
const DESC_DEDICATED_OFFSET = 272;

function init(): void {
  lib = koffi.load('dxgi.dll');

  // IID_IDXGIFactory1 = {770aae78-f26f-4dba-a829-253c83d1b387}
  iidFactory1 = Buffer.alloc(16);
  iidFactory1.writeUInt32LE(0x770aae78, 0);
  iidFactory1.writeUInt16LE(0xf26f, 4);
  iidFactory1.writeUInt16LE(0x4dba, 6);
  iidFactory1[8] = 0xa8;
  iidFactory1[9] = 0x29;
  iidFactory1[10] = 0x25;
  iidFactory1[11] = 0x3c;
  iidFactory1[12] = 0x83;
  iidFactory1[13] = 0xd1;
  iidFactory1[14] = 0xb3;
  iidFactory1[15] = 0x87;

  CreateDXGIFactory1 = lib.func('int32 CreateDXGIFactory1(void *riid, void *ppFactory)');
  EnumAdapters1Type = koffi.proto('int32', ['void *', 'uint32', 'void *']);
  GetDescType = koffi.proto('int32', ['void *', 'void *']);
  ReleaseType = koffi.proto('uint32', ['void *']);
  initialized = true;
}

function vtableMethod(vtable: bigint, index: number): bigint {
  return koffi.decode(vtable + BigInt(index) * BigInt(8), 'void *') as bigint;
}

export function enumerateGpus(): DxgiGpuInfo[] {
  if (process.platform !== 'win32') return [];
  try {
    if (!initialized) init();

    const factorySlot = koffi.alloc('void *', 1);
    const hr = CreateDXGIFactory1(iidFactory1, factorySlot);
    if (hr < 0) return [];
    const factory = koffi.decode(factorySlot, 'void *') as bigint;
    if (!factory) return [];
    const factoryVtable = koffi.decode(factory, 'void *') as bigint;

    const enumAdapters1Ptr = vtableMethod(factoryVtable, VT_ENUM_ADAPTERS1);
    const out: DxgiGpuInfo[] = [];

    for (let i = 0; i < 8; i++) {
      const adapterSlot = koffi.alloc('void *', 1);
      const r = koffi.call(enumAdapters1Ptr, EnumAdapters1Type, factory, i, adapterSlot);
      if (r < 0) break; // DXGI_ERROR_NOT_FOUND when enumeration is done
      const adapter = koffi.decode(adapterSlot, 'void *') as bigint;
      if (!adapter) break;

      const adapterVtable = koffi.decode(adapter, 'void *') as bigint;
      const getDescPtr = vtableMethod(adapterVtable, VT_GET_DESC);
      const desc = Buffer.alloc(DESC_SIZE);
      const dr = koffi.call(getDescPtr, GetDescType, adapter, desc);
      if (dr >= 0) {
        const model = desc
          .toString('utf16le', 0, DESC_DESCRIPTION_BYTES)
          .replace(/\u0000+$/, '')
          .trim();
        const vendorId = desc.readUInt32LE(DESC_VENDOR_ID_OFFSET);
        const dedicated = desc.readBigUInt64LE(DESC_DEDICATED_OFFSET);
        out.push({
          model: model || null,
          vendorId: vendorId || null,
          utilPercent: null,
          memoryUsedMb: null,
          memoryTotalMb: dedicated > BigInt(0) ? Math.round(Number(dedicated) / 1048576) : null,
        });
      }

      koffi.call(vtableMethod(adapterVtable, VT_RELEASE), ReleaseType, adapter);
    }

    koffi.call(vtableMethod(factoryVtable, VT_RELEASE), ReleaseType, factory);
    return out;
  } catch {
    return [];
  }
}
