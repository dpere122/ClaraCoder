import { describe, expect, it, vi } from 'vitest';

vi.mock('../../python/http-client', () => ({ pythonSseGet: vi.fn() }));
vi.mock('../../python/server', () => ({ isPythonHealthy: vi.fn(async () => false) }));
vi.mock('../../state', () => ({ mainState: {} }));
vi.mock('./chat-subagent-relay', () => ({ createSubagentRelay: vi.fn() }));

import type { SubagentRelay } from './chat-subagent-relay';
import { handleSubagentEventBlock } from './subagent-events';

describe('handleSubagentEventBlock', () => {
  it('hands each data line of an SSE block to the relay and skips keepalives', () => {
    const handle = vi.fn(() => true);
    const relay = { handle, finishAll: vi.fn(), runningIds: () => [] } as SubagentRelay;

    handleSubagentEventBlock(': keepalive', relay);
    handleSubagentEventBlock(
      'data: {"type":"subagent_finished","conversation_id":"child-abc12345","outcome":"completed"}',
      relay,
    );

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith({
      type: 'subagent_finished',
      conversationId: 'child-abc12345',
      outcome: 'completed',
    });
  });

  it('keeps handling the rest of a block when one event throws', () => {
    const handle = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      })
      .mockReturnValue(true);
    const relay = { handle, finishAll: vi.fn(), runningIds: () => [] } as SubagentRelay;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    handleSubagentEventBlock(
      [
        'data: {"type":"subagent_finished","conversation_id":"child-abc12345","outcome":"completed"}',
        'data: {"type":"subagent_finished","conversation_id":"child-def67890","outcome":"aborted"}',
      ].join('\n'),
      relay,
    );

    expect(handle).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
