import { describe, expect, it } from 'vitest';
import {
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION,
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
  ACCEPT_COMMAND_KIND_DEFERRED_TOOL,
  acceptCommandGrantsAdminElevation,
} from './accept-command';

const done = { requestId: 'r1', status: 'complete' as const };

describe('acceptCommandGrantsAdminElevation', () => {
  it('grants for completed Admin cards', () => {
    expect(acceptCommandGrantsAdminElevation({ ...done, kind: ACCEPT_COMMAND_KIND_ADMIN_ELEVATION })).toBe(true);
    expect(
      acceptCommandGrantsAdminElevation({ ...done, action: 'confirm', kind: ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL }),
    ).toBe(true);
  });

  it('grants for "this session" on an elevated deferred tool card', () => {
    expect(
      acceptCommandGrantsAdminElevation({ ...done, action: 'confirm_session', kind: ACCEPT_COMMAND_KIND_DEFERRED_TOOL }),
    ).toBe(true);
  });

  it('never grants for an MCP "Allow all tools" choice', () => {
    expect(acceptCommandGrantsAdminElevation({ ...done, action: 'confirm_session', kind: 'mcp_tool' })).toBe(false);
  });

  it('does not grant for a cancelled card or a plain confirm', () => {
    expect(
      acceptCommandGrantsAdminElevation({
        requestId: 'r1',
        status: 'cancelled',
        kind: ACCEPT_COMMAND_KIND_ADMIN_ELEVATION,
      }),
    ).toBe(false);
    expect(acceptCommandGrantsAdminElevation({ ...done, action: 'confirm', kind: ACCEPT_COMMAND_KIND_DEFERRED_TOOL })).toBe(
      false,
    );
  });
});
