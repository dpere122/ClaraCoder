import type { ToolPillCategory } from '@shared/index';

/** One step of a stretch of work, as the synapse graph draws it. */
export type SynapseKind = 'think' | 'read' | 'search' | 'edit' | 'run' | 'web';

/** A step and the LLM step it ran in: calls sharing a `batch` ran in parallel and share a column. */
export interface SynapseStep {
  kind: SynapseKind;
  batch?: string;
}

/** SVG path data per stroke or fill style. */
export interface SynapsePaths {
  /** Curved links between consecutive columns. */
  links: string;
  /** Links into a column that came after a thought: dashed arcs. */
  arcs: string;
  /** Web satellites' stalks. */
  stalks: string;
  /** Search nodes' dendrites. */
  dendrites: string;
  /** Halo ring around edit nodes. */
  rings: string;
  /** A thought still in progress at the end of the graph. */
  pending: string;
  /** Lookup nodes (read, search). */
  lookups: string;
  /** Structure nodes: the start node, run diamonds, web nodes and satellites. */
  nodes: string;
  /** Change nodes (edit). */
  changes: string;
}

export interface SynapsePoint {
  x: number;
  y: number;
}

export interface SynapseGraph {
  /** Graph width in viewBox units (the height is always {@link SYNAPSE_HEIGHT}). */
  width: number;
  paths: SynapsePaths;
  /** First node of the newest column (where the live halo sits). */
  head: SynapsePoint;
  /** First node of the column before it (where the live pulse starts). */
  from: SynapsePoint;
  /** Columns drawn: a view uses the count to tell that a step landed. */
  columns: number;
}

export const SYNAPSE_HEIGHT = 20;
const GAP = 12;
const MAX_WIDTH = 170;
const START: SynapsePoint = { x: 2, y: 10 };
const BASE_Y: Readonly<Record<Exclude<SynapseKind, 'think'>, number>> = {
  read: 8.5,
  search: 11.5,
  edit: 10,
  run: 10,
  web: 8,
};

/** Synapse node for a tool row's category: lookups read, edits change, `other` tools act like commands. */
export function synapseKindForCategory(category: ToolPillCategory): SynapseKind {
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

const round = (n: number): number => Math.round(n * 100) / 100;

function circle(x: number, y: number, r: number): string {
  return `M${round(x - r)} ${round(y)}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0`;
}

interface Column {
  batch?: string;
  kinds: Exclude<SynapseKind, 'think'>[];
  /** A thought came right before this column. */
  afterThought: boolean;
}

function toColumns(steps: readonly SynapseStep[]): { columns: Column[]; thinking: boolean } {
  const columns: Column[] = [];
  let thought = false;
  for (const step of steps) {
    if (step.kind === 'think') {
      thought = true;
      continue;
    }
    const last = columns[columns.length - 1];
    if (last && step.batch && last.batch === step.batch) {
      last.kinds.push(step.kind);
    } else {
      columns.push({ batch: step.batch, kinds: [step.kind], afterThought: thought });
      thought = false;
    }
  }
  return { columns, thinking: thought };
}

/**
 * The synapse graph for a stretch of work, read left to right: one column per LLM step, calls
 * that ran in parallel stacked in it, curved links fanning between columns, and a dashed arc
 * where the model thought before acting. Deterministic in the step list, so a saved turn
 * redraws the same graph. Long stretches pack their columns tighter to stay within
 * {@link MAX_WIDTH}.
 */
export function synapseGraph(steps: readonly SynapseStep[]): SynapseGraph {
  const { columns, thinking } = toColumns(steps);
  const gap = columns.length > 1 ? Math.min(GAP, (MAX_WIDTH - 10) / columns.length) : GAP;
  const paths: SynapsePaths = {
    links: '',
    arcs: '',
    stalks: '',
    dendrites: '',
    rings: '',
    pending: '',
    lookups: '',
    nodes: circle(START.x, START.y, 1.3),
    changes: '',
  };
  const history: SynapsePoint[][] = [[START]];

  columns.forEach((column, ci) => {
    const x = round(START.x + (ci + 1) * gap);
    const n = column.kinds.length;
    const jitter = (((ci * 7) % 3) - 1) * 1.2;
    const nodes = column.kinds.map((kind, i) => ({
      kind,
      x,
      y: round(n === 1 ? BASE_Y[kind] + jitter : Math.min(17.5, Math.max(2.5, 10 + (i - (n - 1) / 2) * 4.2))),
    }));
    for (const a of history[history.length - 1]!) {
      for (const b of nodes) {
        const mx = round((a.x + b.x) / 2);
        if (column.afterThought) {
          paths.arcs += `M${a.x} ${a.y}Q${mx} ${round(Math.min(a.y, b.y) - 7)} ${b.x} ${b.y}`;
        } else {
          paths.links += `M${a.x} ${a.y}C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
        }
      }
    }
    for (const node of nodes) {
      switch (node.kind) {
        case 'read':
          paths.lookups += circle(node.x, node.y, 1.5);
          break;
        case 'search':
          paths.lookups += circle(node.x, node.y, 1.5);
          paths.dendrites += `M${node.x} ${node.y}l2.6 -2.2M${node.x} ${node.y}l3.2 0M${node.x} ${node.y}l2.6 2.2`;
          break;
        case 'edit':
          paths.changes += circle(node.x, node.y, 2.1);
          paths.rings += circle(node.x, node.y, 3.3);
          break;
        case 'run':
          paths.nodes += `M${node.x} ${round(node.y - 2.1)}l2.1 2.1-2.1 2.1-2.1-2.1z`;
          break;
        case 'web':
          paths.nodes += circle(node.x, node.y, 1.6) + circle(node.x + 3, node.y - 4.5, 0.8) + circle(node.x + 3, node.y + 4.5, 0.8);
          paths.stalks += `M${node.x} ${node.y}l3 -4.5M${node.x} ${node.y}l3 4.5`;
          break;
      }
    }
    history.push(nodes);
  });

  const lastX = START.x + columns.length * gap;
  if (thinking) {
    paths.pending += circle(round(lastX + gap * 0.6), 6, 1.2);
  }
  const newest = history[history.length - 1]!;
  const before = history.length >= 2 ? history[history.length - 2]! : newest;
  return {
    width: round(lastX + gap * 0.9 + 3),
    paths,
    head: { x: newest[0]!.x, y: newest[0]!.y },
    from: { x: before[0]!.x, y: before[0]!.y },
    columns: columns.length,
  };
}
