import { describe, expect, it } from 'vitest';
import { resolveStartupWorkspaceId, shouldOpenHomePageOnStart } from './app-config';

describe('shouldOpenHomePageOnStart', () => {
  it('is off unless the flag is explicitly true', () => {
    expect(shouldOpenHomePageOnStart({})).toBe(false);
    expect(shouldOpenHomePageOnStart({ defaultHomePageOnStart: false })).toBe(false);
    expect(shouldOpenHomePageOnStart({ defaultHomePageOnStart: true })).toBe(true);
  });
});

describe('resolveStartupWorkspaceId', () => {
  it('restores the last workspace when home-on-start is off', () => {
    expect(
      resolveStartupWorkspaceId({ currentWorkspaceId: 'ws-a', defaultHomePageOnStart: false }),
    ).toBe('ws-a');
  });

  it('stays on the home screen when home-on-start is on', () => {
    expect(
      resolveStartupWorkspaceId({ currentWorkspaceId: 'ws-a', defaultHomePageOnStart: true }),
    ).toBeNull();
  });
});
