import { describe, expect, it } from 'vitest';
import type { ConversationMeta } from '@shared/index';
import { buildConversationTree } from './conversation-tree';

function meta(id: string, createdAt: string, parentConversationId?: string): ConversationMeta {
  return {
    id,
    title: id,
    createdAt,
    updatedAt: createdAt,
    workspaceId: 'ws-1',
    customTitle: false,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

describe('buildConversationTree', () => {
  it('nests sub-agent conversations under their parent, oldest first, keeping root order', () => {
    const tree = buildConversationTree([
      meta('child-late', '2026-10-20T03:00:00Z', 'p1'),
      meta('p2', '2026-10-20T02:30:00Z'),
      meta('p1', '2026-10-20T01:00:00Z'),
      meta('child-early', '2026-10-20T02:00:00Z', 'p1'),
    ]);

    expect(tree.map((n) => n.conversation.id)).toEqual(['p2', 'p1']);
    expect(tree[1]!.children.map((c) => c.id)).toEqual(['child-early', 'child-late']);
    expect(tree[0]!.children).toEqual([]);
  });

  it('lists a sub-agent whose parent is not in the list as a top-level row', () => {
    const tree = buildConversationTree([meta('orphan', '2026-10-20T01:00:00Z', 'gone'), meta('p1', '2026-10-20T00:00:00Z')]);
    expect(tree.map((n) => n.conversation.id)).toEqual(['orphan', 'p1']);
  });

  it('never nests a conversation under itself', () => {
    const tree = buildConversationTree([meta('self', '2026-10-20T01:00:00Z', 'self')]);
    expect(tree.map((n) => n.conversation.id)).toEqual(['self']);
  });
});
