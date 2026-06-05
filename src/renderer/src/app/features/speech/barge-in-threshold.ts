/** Minimum mic RMS when assistant TTS is not playing (open mic / headphones). */
export const SILENCE_RMS = 0.015;

export const BARGE_IN_RATIO = 1.2;
export const BARGE_IN_MARGIN = 0.008;
export const PLAYBACK_ACTIVE_EPS = 0.003;
export const BARGE_IN_MAX_THRESHOLD = 0.1;

/** Consecutive mic buffers above threshold before starting capture (~256 ms at 48 kHz / 4096). */
export const BARGE_SUSTAIN_BUFFERS = 3;

export interface BargeInThresholdOptions {
  silenceRms?: number;
  ratio?: number;
  margin?: number;
  playbackActiveEps?: number;
  maxThreshold?: number;
}

/**
 * Mic must exceed this RMS to count as user speech while talk mode is listening.
 * When assistant playback is active, the floor rises with playback level (capped for headphones).
 */
export function computeBargeThreshold(
  playbackRms: number,
  opts: BargeInThresholdOptions = {},
): number {
  const silenceRms = opts.silenceRms ?? SILENCE_RMS;
  const ratio = opts.ratio ?? BARGE_IN_RATIO;
  const margin = opts.margin ?? BARGE_IN_MARGIN;
  const playbackActiveEps = opts.playbackActiveEps ?? PLAYBACK_ACTIVE_EPS;
  const maxThreshold = opts.maxThreshold ?? BARGE_IN_MAX_THRESHOLD;

  const playbackGate =
    playbackRms > playbackActiveEps
      ? Math.min(playbackRms * ratio + margin, maxThreshold)
      : 0;
  return Math.max(silenceRms, playbackGate);
}

export function micExceedsBargeThreshold(
  micRms: number,
  playbackRms: number,
  opts?: BargeInThresholdOptions,
): boolean {
  return micRms > computeBargeThreshold(playbackRms, opts);
}
