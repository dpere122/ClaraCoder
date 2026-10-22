import type { ConversationMeta } from '@shared/index';

/** One top-level conversation row and the sub-agent conversations it spawned. */
export interface ConversationTreeNode {
  conversation: ConversationMeta;
  /** Sub-agent conversations, oldest first (spawn order). */
  children: ConversationMeta[];
}

/**
 * Nest sub-agent conversations under the conversation that spawned them. Top-level rows keep the
 * list's order (most recent first); a sub-agent whose parent is not in the list is shown as a
 * top-level row so it never disappears.
 */
export function buildConversationTree(metas: readonly ConversationMeta[]): ConversationTreeNode[] {
  const ids = new Set(metas.map((m) => m.id));
  const childrenByParent = new Map<string, ConversationMeta[]>();
  const roots: ConversationMeta[] = [];
  for (const meta of metas) {
    const parentId = meta.parentConversationId;
    if (parentId && parentId !== meta.id && ids.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(meta);
      childrenByParent.set(parentId, siblings);
    } else {
      roots.push(meta);
    }
  }
  return roots.map((conversation) => ({
    conversation,
    children: (childrenByParent.get(conversation.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

/** A tree row after filtering; `forceExpanded` marks a parent kept only for its matching sub-agents. */
export interface FilteredConversationTreeNode extends ConversationTreeNode {
  forceExpanded: boolean;
}

/**
 * Keep the rows whose title contains `query` (case-insensitive; titles only, not message text).
 * A matching parent keeps all its sub-agents; otherwise a parent stays only to hold the sub-agents
 * that match, and is forced open so the match is visible.
 */
export function filterConversationTree(
  tree: readonly ConversationTreeNode[],
  query: string,
): FilteredConversationTreeNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return tree.map((node) => ({ ...node, forceExpanded: false }));
  }
  const matches = (c: ConversationMeta) => c.title.toLocaleLowerCase().includes(needle);
  const out: FilteredConversationTreeNode[] = [];
  for (const node of tree) {
    if (matches(node.conversation)) {
      out.push({ ...node, forceExpanded: false });
      continue;
    }
    const children = node.children.filter(matches);
    if (children.length > 0) {
      out.push({ conversation: node.conversation, children, forceExpanded: true });
    }
  }
  return out;
}

export type ConversationDateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

const DATE_BUCKET_LABELS: Record<ConversationDateBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Last 7 days',
  month: 'Last 30 days',
  older: 'Older',
};

const DATE_BUCKET_ORDER: readonly ConversationDateBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Which list section a conversation last updated at `iso` falls in, by local calendar day. */
export function conversationDateBucket(iso: string, now: Date): ConversationDateBucket {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return 'older';
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) {
    return 'today';
  }
  if (t >= startOfToday - DAY_MS) {
    return 'yesterday';
  }
  if (t >= startOfToday - 6 * DAY_MS) {
    return 'week';
  }
  if (t >= startOfToday - 29 * DAY_MS) {
    return 'month';
  }
  return 'older';
}

/** Split top-level rows into date sections (newest section first), keeping row order inside each. */
export function groupConversationTreeByDate<T extends ConversationTreeNode>(
  nodes: readonly T[],
  now: Date,
): Array<{ bucket: ConversationDateBucket; label: string; nodes: T[] }> {
  const byBucket = new Map<ConversationDateBucket, T[]>();
  for (const node of nodes) {
    const bucket = conversationDateBucket(node.conversation.updatedAt, now);
    const list = byBucket.get(bucket) ?? [];
    list.push(node);
    byBucket.set(bucket, list);
  }
  return DATE_BUCKET_ORDER.filter((b) => byBucket.has(b)).map((bucket) => ({
    bucket,
    label: DATE_BUCKET_LABELS[bucket],
    nodes: byBucket.get(bucket)!,
  }));
}

/** Short age for the row's right edge: `now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `1y`. */
export function conversationAgeLabel(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, now.getTime() - t) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  if (days < 30) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
}
