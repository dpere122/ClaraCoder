import type { LlamaServerStatusPayload, LlamaServerStatusResult, ManagedServerHealthState } from '@shared/index';

/** Single hue channel for the crystal (derived from smoothed server status). */
export type LlamaCrystalAggregate = 'off' | 'loading' | 'ok' | 'error';

const STABLE_OK_MS = 15_000;
const UNSTABLE_MS = 2_500;

export function llamaCrystalAggregateFromPayload(st: LlamaServerStatusPayload | null): LlamaCrystalAggregate {
  if (!st || !st.running) {
    return 'off';
  }
  const parts: ManagedServerHealthState[] = [st.chat.health];
  if (st.embed) {
    parts.push(st.embed.health);
  }
  if (parts.some((h) => h === 'error')) {
    return 'error';
  }
  if (parts.some((h) => h === 'loading')) {
    return 'loading';
  }
  if (parts.every((h) => h === 'ok')) {
    return 'ok';
  }
  return 'off';
}

/**
 * Poll interval: slow while chat (+ embed if any) are ok and running; faster when warming, failing, or stopped.
 */
export function computeStatusPollIntervalMs(status: LlamaServerStatusResult | null): number {
  if (!status || status.ok === false) {
    return UNSTABLE_MS;
  }
  if (!status.running) {
    return UNSTABLE_MS;
  }
  const parts: ManagedServerHealthState[] = [status.chat.health];
  if (status.embed) {
    parts.push(status.embed.health);
  }
  if (parts.every((h) => h === 'ok')) {
    return STABLE_OK_MS;
  }
  return UNSTABLE_MS;
}

/** RGB 0–1 for emissive tint (crystal lerp target). */
export interface LlamaCrystalVisualTargets {
  baseRgb: [number, number, number];
  emissiveRgb: [number, number, number];
  emissiveIntensity: number;
  /** Extra emissive swing for loading pulse (peak delta on intensity). */
  loadingPulseAmplitude: number;
}

export function crystalVisualTargets(aggregate: LlamaCrystalAggregate): LlamaCrystalVisualTargets {
  switch (aggregate) {
    case 'off':
      return {
        baseRgb: [0.78, 0.8, 0.82],
        emissiveRgb: [0.04, 0.055, 0.07],
        emissiveIntensity: 0.06,
        loadingPulseAmplitude: 0,
      };
    case 'loading':
      return {
        baseRgb: [0.82, 0.76, 0.62],
        emissiveRgb: [0.45, 0.32, 0.12],
        emissiveIntensity: 0.18,
        loadingPulseAmplitude: 0.06,
      };
    case 'ok':
      return {
        baseRgb: [0.72, 0.84, 0.8],
        emissiveRgb: [0.12, 0.32, 0.26],
        emissiveIntensity: 0.16,
        loadingPulseAmplitude: 0,
      };
    case 'error':
      return {
        baseRgb: [0.82, 0.7, 0.72],
        emissiveRgb: [0.35, 0.1, 0.14],
        emissiveIntensity: 0.2,
        loadingPulseAmplitude: 0,
      };
    default:
      return crystalVisualTargets('off');
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential smoothing factor from time constant (seconds) and delta seconds. */
export function expSmoothingAlpha(deltaSec: number, tauSec: number): number {
  if (tauSec <= 0) {
    return 1;
  }
  return 1 - Math.exp(-deltaSec / tauSec);
}
