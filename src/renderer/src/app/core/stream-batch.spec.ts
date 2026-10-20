import { mergeStreamBatchQueue, type StreamBatchItem } from './stream-batch';

describe('mergeStreamBatchQueue', () => {
  it('returns empty for empty input', () => {
    expect(mergeStreamBatchQueue([])).toEqual([]);
  });

  it('merges consecutive chunk deltas for same conversation and streamTag', () => {
    const q: StreamBatchItem[] = [
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'hello', streamTag: 'agent' } },
      { kind: 'chunk', msg: { conversationId: 'c1', delta: ' world', streamTag: 'agent' } },
    ];
    expect(mergeStreamBatchQueue(q)).toEqual([
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'hello world', streamTag: 'agent' } },
    ]);
  });

  it('does not merge chunks across different stream tags', () => {
    const q: StreamBatchItem[] = [
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'a', streamTag: 'agent' } },
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'b', streamTag: 'reasoning' } },
    ];
    const out = mergeStreamBatchQueue(q);
    expect(out).toHaveLength(2);
  });

  it('merges toolExec chunks with same label and streamTag', () => {
    const q: StreamBatchItem[] = [
      {
        kind: 'toolExec',
        msg: { conversationId: 'c1', delta: 'x', streamTag: 'sh', label: 'bash' },
      },
      {
        kind: 'toolExec',
        msg: { conversationId: 'c1', delta: 'y', streamTag: 'sh', label: 'bash' },
      },
    ];
    expect(mergeStreamBatchQueue(q)).toEqual([
      {
        kind: 'toolExec',
        msg: { conversationId: 'c1', delta: 'xy', streamTag: 'sh', label: 'bash' },
      },
    ]);
  });

  it('merges read chunks only within one tool status row', () => {
    const q: StreamBatchItem[] = [
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'a', statusId: 'r1' } },
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'b', statusId: 'r1' } },
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'c', statusId: 'r2' } },
    ];
    expect(mergeStreamBatchQueue(q)).toEqual([
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'ab', statusId: 'r1' } },
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'c', statusId: 'r2' } },
    ]);
  });

  it('preserves interleaving across chunk kinds', () => {
    const q: StreamBatchItem[] = [
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'a', streamTag: 'agent' } },
      { kind: 'toolRead', msg: { conversationId: 'c1', delta: 'read1' } },
      { kind: 'chunk', msg: { conversationId: 'c1', delta: 'b', streamTag: 'agent' } },
    ];
    const out = mergeStreamBatchQueue(q);
    expect(out).toHaveLength(3);
    expect(out[0]?.kind).toBe('chunk');
    expect(out[1]?.kind).toBe('toolRead');
    expect(out[2]?.kind).toBe('chunk');
  });

  it('merges toolExec chunks then keeps toolExecComplete in order', () => {
    const q: StreamBatchItem[] = [
      {
        kind: 'toolExec',
        msg: { conversationId: 'c1', delta: 'a', streamTag: 't', label: 'L' },
      },
      {
        kind: 'toolExec',
        msg: { conversationId: 'c1', delta: 'b', streamTag: 't', label: 'L' },
      },
      {
        kind: 'toolExecComplete',
        msg: { conversationId: 'c1', streamTag: 't', label: 'L', exitCode: 0 },
      },
    ];
    const out = mergeStreamBatchQueue(q);
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe('toolExec');
    if (out[0]?.kind === 'toolExec') {
      expect(out[0].msg.delta).toBe('ab');
    }
    expect(out[1]?.kind).toBe('toolExecComplete');
  });
});
