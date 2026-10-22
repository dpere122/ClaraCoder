import type { ToolPillCategory } from '@shared/index';

/** One step of a stretch of work, as the turn fractal reads it. */
export type FractalKind = 'think' | 'read' | 'search' | 'edit' | 'run' | 'web';

/** SVG path data per stroke style: `line` (structure), `third` (lookups), `hi` (changes), `dots` (web nodes). */
export interface FractalPaths {
  line: string;
  third: string;
  hi: string;
  dots: string;
}

export interface TurnFractal {
  /** Square viewBox fitted around the whole shape. */
  viewBox: string;
  /** Everything but the newest step. */
  base: FractalPaths;
  /** What the newest step added (empty when it was a thought). */
  newest: FractalPaths;
  /** Number of steps drawn, so a view can tell a new step landed. */
  steps: number;
}

type Rule =
  | { twist: number }
  | { branches: readonly number[]; len: number; style: 'line' | 'third' | 'hi'; alt?: boolean; dots?: boolean };

/**
 * Growth rule per step, applied to every current tip: lookups fork fine branches, an edit grows
 * one long heavy branch, a command turns 60° (alternating sides), web calls spread three ways
 * with nodes, and a thought grows nothing but twists the next branches.
 */
const RULES: Readonly<Record<FractalKind, Rule>> = {
  think: { twist: 16 },
  read: { branches: [-24, 24], len: 0.64, style: 'third' },
  search: { branches: [-36, 0, 36], len: 0.56, style: 'third' },
  edit: { branches: [7], len: 0.88, style: 'hi' },
  run: { branches: [60], len: 0.74, style: 'line', alt: true },
  web: { branches: [-60, 0, 60], len: 0.6, style: 'line', dots: true },
};

/** Tips kept per generation (evenly spaced), so long stretches stay legible at icon size. */
const MAX_TIPS = 8;
const MIN_LEN = 1.3;

/** Fractal step for a tool row's category: lookups read, edits change, `other` tools act like commands. */
export function fractalKindForCategory(category: ToolPillCategory): FractalKind {
  switch (category) {
    case 'read':
    case 'list':
    case 'lsp':
      return 'read';
    case 'search':
      return 'search';
    case 'edit':
      return 'edit';
    case 'web':
      return 'web';
    default:
      return 'run';
  }
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  style: 'line' | 'third' | 'hi';
  gen: number;
}

interface Dot {
  x: number;
  y: number;
  gen: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

function emptyPaths(): FractalPaths {
  return { line: '', third: '', hi: '', dots: '' };
}

/**
 * The turn fractal for a stretch of work: a trunk that grows one generation per step, in order.
 * Deterministic, so a saved turn redraws the same shape and the same tool sequence always
 * looks the same. A stretch with no branches (thinking only) gets a node on its trunk tip.
 */
export function turnFractal(kinds: readonly FractalKind[]): TurnFractal {
  const segments: Segment[] = [{ x1: 0, y1: 8, x2: 0, y2: 0, style: 'line', gen: 0 }];
  const dots: Dot[] = [];
  let tips = [{ x: 0, y: 0, a: -90, len: 7 }];
  let twist = 0;
  let runSign = 1;
  let gen = 0;

  for (const kind of kinds) {
    const rule = RULES[kind];
    gen += 1;
    if ('twist' in rule) {
      twist += rule.twist;
      continue;
    }
    const next: typeof tips = [];
    for (const tip of tips) {
      for (const branch of rule.branches) {
        const a = tip.a + (rule.alt ? branch * runSign : branch) + twist;
        const len = Math.max(MIN_LEN, tip.len * rule.len);
        const rad = (a * Math.PI) / 180;
        const x2 = tip.x + len * Math.cos(rad);
        const y2 = tip.y + len * Math.sin(rad);
        segments.push({ x1: tip.x, y1: tip.y, x2, y2, style: rule.style, gen });
        next.push({ x: x2, y: y2, a, len });
        if (rule.dots) {
          dots.push({ x: x2, y: y2, gen });
        }
      }
    }
    if (rule.alt) {
      runSign = -runSign;
    }
    twist = 0;
    tips =
      next.length > MAX_TIPS
        ? Array.from({ length: MAX_TIPS }, (_, i) => next[Math.round((i * (next.length - 1)) / (MAX_TIPS - 1))]!)
        : next;
  }
  if (segments.length === 1) {
    dots.push({ x: 0, y: 0, gen });
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segments) {
    x0 = Math.min(x0, s.x1, s.x2);
    x1 = Math.max(x1, s.x1, s.x2);
    y0 = Math.min(y0, s.y1, s.y2);
    y1 = Math.max(y1, s.y1, s.y2);
  }
  const size = Math.max(x1 - x0, y1 - y0, 6) * 1.14;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = round(size * 0.04);

  const base = emptyPaths();
  const newest = emptyPaths();
  for (const s of segments) {
    const into = gen > 0 && s.gen === gen ? newest : base;
    into[s.style] += `M${round(s.x1)} ${round(s.y1)}L${round(s.x2)} ${round(s.y2)}`;
  }
  for (const d of dots) {
    const into = gen > 0 && d.gen === gen && segments.length > 1 ? newest : base;
    into.dots += `M${round(d.x - r)} ${round(d.y)}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0`;
  }

  return {
    viewBox: `${round(cx - size / 2)} ${round(cy - size / 2)} ${round(size)} ${round(size)}`,
    base,
    newest,
    steps: kinds.length,
  };
}
