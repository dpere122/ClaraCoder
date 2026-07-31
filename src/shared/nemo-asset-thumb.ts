/** Default max edge (CSS thumbs are ~3.5rem; 128 covers 2x DPR). */
export const DEFAULT_THUMB_MAX_EDGE = 128;

const MIN_THUMB_MAX_EDGE = 32;
const MAX_THUMB_MAX_EDGE = 512;

/**
 * Parse `thumb` / `w` query params. Returns a positive max edge when a thumbnail
 * was requested, otherwise null (full asset).
 *
 * - `thumb=1` / `thumb=true` → {@link DEFAULT_THUMB_MAX_EDGE}
 * - `w=<n>` → clamped edge (wins over bare `thumb` when both present)
 */
export function parseThumbMaxEdge(
  thumbParam: string | null,
  widthParam: string | null,
): number | null {
  if (widthParam != null && widthParam.trim() !== '') {
    const n = Number.parseInt(widthParam, 10);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(MAX_THUMB_MAX_EDGE, Math.max(MIN_THUMB_MAX_EDGE, n));
    }
  }
  if (thumbParam == null) {
    return null;
  }
  const t = thumbParam.trim().toLowerCase();
  if (t === '' || t === '0' || t === 'false' || t === 'no') {
    return null;
  }
  return DEFAULT_THUMB_MAX_EDGE;
}

/** Fit `width`×`height` inside `maxEdge`, preserving aspect ratio (integers ≥ 1). */
export function computeThumbDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxEdge <= 0) {
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const edge = Math.max(width, height);
  if (edge <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
