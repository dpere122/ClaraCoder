import { describe, expect, it } from 'vitest';
import type { ConversationMeta } from '@shared/index';
import {
  buildConversationTree,
  conversationAgeLabel,
  conversationDateBucket,
  filterConversationTree,
  groupConversationTreeByDate,
} from './conversation-tree';

function meta(id: string, createdAt: string, parentConversationId?: string, title = id): ConversationMeta {
  return {
    id,
    title,
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

describe('filterConversationTree', () => {
  const tree = buildConversationTree([
    meta('p1', '2026-10-20T01:00:00Z', undefined, 'Flat IDE chat turns'),
    meta('c1', '2026-10-20T02:00:00Z', 'p1', 'Audit pill CSS'),
    meta('c2', '2026-10-20T03:00:00Z', 'p1', 'Regenerate theme registry'),
    meta('p2', '2026-10-19T01:00:00Z', undefined, 'Ripgrep search'),
  ]);

  it('returns every row unchanged for a blank query', () => {
    const out = filterConversationTree(tree, '   ');
    expect(out.map((n) => n.conversation.id)).toEqual(['p1', 'p2']);
    expect(out[0]!.children).toHaveLength(2);
    expect(out.every((n) => !n.forceExpanded)).toBe(true);
  });

  it('matches titles case-insensitively and keeps a matching parent with all its sub-agents', () => {
    const out = filterConversationTree(tree, 'ide CHAT');
    expect(out.map((n) => n.conversation.id)).toEqual(['p1']);
    expect(out[0]!.children.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(out[0]!.forceExpanded).toBe(false);
  });

  it('keeps a parent only for its matching sub-agents and forces it open', () => {
    const out = filterConversationTree(tree, 'theme');
    expect(out.map((n) => n.conversation.id)).toEqual(['p1']);
    expect(out[0]!.children.map((c) => c.id)).toEqual(['c2']);
    expect(out[0]!.forceExpanded).toBe(true);
  });

  it('drops rows with no title match', () => {
    expect(filterConversationTree(tree, 'nothing like this')).toEqual([]);
  });
});

describe('conversation dates', () => {
  const now = new Date(2026, 9, 22, 15, 0, 0);
  const at = (days: number, hours = 0) => new Date(2026, 9, 22 - days, 15 - hours).toISOString();

  it('buckets by local calendar day', () => {
    expect(conversationDateBucket(at(0, 14), now)).toBe('today');
    expect(conversationDateBucket(at(1), now)).toBe('yesterday');
    expect(conversationDateBucket(at(6), now)).toBe('week');
    expect(conversationDateBucket(at(20), now)).toBe('month');
    expect(conversationDateBucket(at(40), now)).toBe('older');
    expect(conversationDateBucket('not a date', now)).toBe('older');
  });

  it('groups rows into sections in date order, keeping row order inside a section', () => {
    const nodes = buildConversationTree([
      meta('old', at(40)),
      meta('today-b', at(0, 2)),
      meta('yday', at(1)),
      meta('today-a', at(0, 1)),
    ]);
    const groups = groupConversationTreeByDate(nodes, now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Older']);
    expect(groups[0]!.nodes.map((n) => n.conversation.id)).toEqual(['today-b', 'today-a']);
  });

  it('labels ages compactly', () => {
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(conversationAgeLabel(ago(20_000), now)).toBe('now');
    expect(conversationAgeLabel(ago(5 * 60_000), now)).toBe('5m');
    expect(conversationAgeLabel(ago(3 * 3_600_000), now)).toBe('3h');
    expect(conversationAgeLabel(ago(2 * 86_400_000), now)).toBe('2d');
    expect(conversationAgeLabel(ago(15 * 86_400_000), now)).toBe('2w');
    expect(conversationAgeLabel(ago(100 * 86_400_000), now)).toBe('3mo');
    expect(conversationAgeLabel(ago(400 * 86_400_000), now)).toBe('1y');
    expect(conversationAgeLabel('bad', now)).toBe('');
  });
});
