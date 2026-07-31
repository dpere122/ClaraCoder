/**
 * Prefer ``CLARA_{suffix}``; fall back to legacy ``NEMO_{suffix}`` for one release.
 * Pass the suffix without prefix, e.g. ``envClara('PYTHON')`` reads CLARA_PYTHON then NEMO_PYTHON.
 */
export function envClara(suffix: string): string | undefined {
  const clara = process.env[`CLARA_${suffix}`]?.trim();
  if (clara) return clara;
  const legacy = process.env[`NEMO_${suffix}`]?.trim();
  return legacy || undefined;
}
