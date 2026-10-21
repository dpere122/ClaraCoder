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
