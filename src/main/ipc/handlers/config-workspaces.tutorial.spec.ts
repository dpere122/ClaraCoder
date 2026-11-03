import { EventEmitter } from 'node:events';
import { mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialClaimResult, TutorialSnapshot, TutorialTransitionResult } from '../../../shared/types/tutorial';

const { handlers, state, appHandlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  appHandlers: new Map<string, (...args: any[]) => void>(),
  state: {
    mainWindow: null as unknown,
    settingsWindow: null as unknown,
    dependenciesWindow: null as unknown,
    healthWindow: null as unknown,
    updaterWindow: null as unknown,
  },
}));

vi.mock('electron', () => ({
  app: { on: (channel: string, handler: (...args: any[]) => void) => appHandlers.set(channel, handler) },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => handlers.set(channel, handler),
    on: vi.fn(),
  },
}));
vi.mock('../../state', () => ({ mainState: state }));
vi.mock('../../paths', () => ({ getConfigPath: () => `${process.env.CLARA_TEST_CONFIG_DIR}/config.json` }));
vi.mock('../../llama-server-manager', () => ({ getLlamaManagedRuntimeOverrides: vi.fn() }));
vi.mock('../../python/workspace-sync', () => ({}));
vi.mock('../../runtime/user-path', () => ({}));
vi.mock('../../workspace/watcher', () => ({}));
vi.mock('./lsp-status', () => ({}));
vi.mock('../../workspace/system-prompt', () => ({}));
vi.mock('../../menu/recent-conversations', () => ({}));
vi.mock('../../menu/application-menu', () => ({}));
vi.mock('./health', () => ({}));
vi.mock('../../workspace/lost-workspace', () => ({}));
vi.mock('../../web/screenshot-maintenance', () => ({}));

class FakeContents extends EventEmitter {
  readonly send = vi.fn();
  readonly mainFrame = {};
  private destroyed = false;
  constructor(readonly id: number) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.emit('destroyed'); }
}

function fakeWindow(contents: FakeContents) {
  return { webContents: contents, isDestroyed: () => contents.isDestroyed() };
}

async function invoke<T>(channel: string, sender: FakeContents, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  return await handler({ sender, senderFrame: sender.mainFrame }, payload) as T;
}

describe('tutorial cross-window IPC', () => {
  let dir: string;
  let home: FakeContents;
  let settings: FakeContents;
  let dependencies: FakeContents;

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    appHandlers.clear();
    dir = mkdtempSync(join(tmpdir(), 'clara-tutorial-ipc-'));
    process.env.CLARA_TEST_CONFIG_DIR = dir;
    home = new FakeContents(1);
    settings = new FakeContents(2);
    dependencies = new FakeContents(3);
    state.mainWindow = fakeWindow(home);
    state.settingsWindow = fakeWindow(settings);
    state.dependenciesWindow = fakeWindow(dependencies);
    state.healthWindow = null;
    state.updaterWindow = null;
    const { registerConfigWorkspacesIpc } = await import('./config-workspaces');
    registerConfigWorkspacesIpc();
  });

  afterEach(() => {
    delete process.env.CLARA_TEST_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants only one competing window and verifies the claimed role', async () => {
    const [a, b] = await Promise.all([
      invoke<TutorialClaimResult>('tutorial:claim', home, 'home'),
      invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings'),
    ]);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    expect(b.snapshot.ownerId).toBe(home.id);
    await expect(invoke('tutorial:claim', settings, 'home')).rejects.toThrow('role');
    await expect(invoke('tutorial:get-snapshot', new FakeContents(99))).rejects.toThrow('Untrusted');
  });

  it('revision-checks simultaneous transitions and rejects mutations from non-owners', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    const [first, second, intruder] = await Promise.all([
      invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 }),
      invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'dismiss-all', expectedRevision: 0 }),
      invoke<TutorialTransitionResult>('tutorial:transition', settings, { action: 'dismiss-all', expectedRevision: 0 }),
    ]);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(intruder.applied).toBe(false);
    const latest = await invoke<TutorialSnapshot>('tutorial:get-snapshot', home);
    expect(latest.progress.active).toEqual({ phaseId: 'intro', stepId: 'welcome' });
    expect(latest.progress.revision).toBe(1);
  });

  it('rejects a queued transition submitted by a non-owner even if ownership later changes', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    const { updateConfig } = await import('../../config/load-save');
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const blocked = updateConfig(async () => { entered(); await gate; });
    await started;
    const unauthorized = invoke<TutorialTransitionResult>('tutorial:transition', settings, { action: 'dismiss-all', expectedRevision: 0 });
    const released = invoke<TutorialSnapshot>('tutorial:release', home, 'settings');
    const claimed = invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings');
    unblock();
    await Promise.all([blocked, released, claimed]);
    expect((await unauthorized).applied).toBe(false);
    expect((await invoke<TutorialSnapshot>('tutorial:get-snapshot', settings)).progress.revision).toBe(0);
  });

  it('rejects an old request after its owner releases and reacquires the same lease', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    const { updateConfig } = await import('../../config/load-save');
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const blocked = updateConfig(async () => { entered(); await gate; });
    await started;
    const oldRequest = invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
    const operations = [
      invoke<TutorialSnapshot>('tutorial:release', home, 'settings'),
      invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings'),
      invoke<TutorialSnapshot>('tutorial:release', settings, 'home'),
      invoke<TutorialClaimResult>('tutorial:claim', home, 'home'),
    ];
    unblock();
    await Promise.all([blocked, ...operations]);
    expect((await oldRequest).applied).toBe(false);
    expect((await invoke<TutorialSnapshot>('tutorial:get-snapshot', home)).progress.revision).toBe(0);
  });

  it('rolls back a claim when reading the config fails', async () => {
    await invoke<TutorialSnapshot>('tutorial:get-snapshot', home);
    const configPath = join(dir, 'config.json');
    const valid = readFileSync(configPath, 'utf8');
    rmSync(`${configPath}.bak`, { force: true });
    writeFileSync(configPath, '{invalid', 'utf8');
    await expect(invoke<TutorialClaimResult>('tutorial:claim', home, 'home')).rejects.toThrow();
    writeFileSync(configPath, valid, 'utf8');
    expect((await invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings')).acquired).toBe(true);
  });

  it('hands off exclusively, releases on window closure, and resumes the committed cursor', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    await invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
    const release = await invoke<TutorialSnapshot>('tutorial:release', home, 'dependencies');
    expect(release.requestedWindow).toBe('dependencies');
    expect((await invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings')).acquired).toBe(false);
    expect((await invoke<TutorialClaimResult>('tutorial:claim', home, 'home')).acquired).toBe(false);
    const claimed = await invoke<TutorialClaimResult>('tutorial:claim', dependencies, 'dependencies');
    expect(claimed.acquired).toBe(true);
    home.send.mockClear();
    dependencies.destroy();
    await vi.waitFor(() => {
      expect(home.send.mock.calls.some(([channel, snapshot]) => channel === 'tutorial:updated' && snapshot.ownerId === null)).toBe(true);
    });
    const recovered = await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    expect(recovered.acquired).toBe(true);
    expect(recovered.snapshot.progress.active).toEqual({ phaseId: 'intro', stepId: 'welcome' });
  });

  it('releases a pending handoff when its target closes before claiming', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    await invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
    await invoke<TutorialSnapshot>('tutorial:release', home, 'dependencies');
    home.send.mockClear();
    dependencies.destroy();
    await vi.waitFor(() => {
      expect(home.send.mock.calls.some(([channel, snapshot]) => channel === 'tutorial:updated' && snapshot.requestedWindow === null)).toBe(true);
    });
    const resumed = await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    expect(resumed.acquired).toBe(true);
    expect(resumed.snapshot.progress.active?.stepId).toBe('welcome');
  });

  it('releases when a newly created destination closes before its first renderer request', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    state.dependenciesWindow = null;
    await invoke<TutorialSnapshot>('tutorial:release', home, 'dependencies');
    const next = new FakeContents(44);
    const win = fakeWindow(next);
    appHandlers.get('browser-window-created')?.({}, win);
    state.dependenciesWindow = win;
    await new Promise<void>((resolve) => setImmediate(resolve));
    home.send.mockClear();
    next.destroy();
    await vi.waitFor(() => {
      expect(home.send.mock.calls.some(([channel, snapshot]) => channel === 'tutorial:updated' && snapshot.requestedWindow === null)).toBe(true);
    });
    expect((await invoke<TutorialClaimResult>('tutorial:claim', home, 'home')).acquired).toBe(true);
  });

  it('unblocks a handoff when the requested window never opens', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    state.dependenciesWindow = null;
    vi.useFakeTimers();
    try {
      await invoke<TutorialSnapshot>('tutorial:release', home, 'dependencies');
      expect((await invoke<TutorialClaimResult>('tutorial:claim', home, 'home')).acquired).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await invoke<TutorialClaimResult>('tutorial:claim', home, 'home')).acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the lease after a renderer crash without dismissing progress', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    await invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
    home.emit('render-process-gone');
    const resumed = await invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings');
    expect(resumed.acquired).toBe(true);
    expect(resumed.snapshot.progress.active?.stepId).toBe('welcome');
  });

  it('broadcasts tutorial-only updates without replacing a dirty Settings draft', async () => {
    const draft = { sourceName: 'unsaved draft' };
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    await invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
    expect(draft.sourceName).toBe('unsaved draft');
    expect(settings.send).toHaveBeenCalled();
    expect(settings.send.mock.calls.every(([channel]) => channel === 'tutorial:updated')).toBe(true);
    expect(settings.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('llmProviders');
  });
  it('rejects tutorial IPC from a subframe of an otherwise trusted window', async () => {
    const handler = handlers.get('tutorial:claim')!;
    await expect(handler({ sender: home, senderFrame: {} }, 'home')).rejects.toThrow('Untrusted tutorial frame');
    expect((await invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings')).acquired).toBe(true);
  });

  it('does not report an old claim as acquired after the same window releases and reacquires', async () => {
    const { updateConfig } = await import('../../config/load-save');
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const blocked = updateConfig(async () => { entered(); await gate; });
    await started;
    const oldClaim = invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    const released = invoke<TutorialSnapshot>('tutorial:release', home);
    const newClaim = invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    unblock();
    await Promise.all([blocked, released]);
    expect((await oldClaim).acquired).toBe(false);
    expect((await newClaim).acquired).toBe(true);
  });

  it('cancels a staged transition if its owner releases during the disk write', async () => {
    await invoke<TutorialClaimResult>('tutorial:claim', home, 'home');
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('config.json.bak')) {
        entered();
        await gate;
      }
      return rename(from, to);
    });
    try {
      const pending = invoke<TutorialTransitionResult>('tutorial:transition', home, { action: 'start', expectedRevision: 0 });
      await started;
      const released = invoke<TutorialSnapshot>('tutorial:release', home, 'settings');
      const claimed = invoke<TutorialClaimResult>('tutorial:claim', settings, 'settings');
      unblock();
      expect((await pending).applied).toBe(false);
      await released;
      expect((await claimed).acquired).toBe(true);
      expect((await invoke<TutorialSnapshot>('tutorial:get-snapshot', settings)).progress)
        .toEqual({ revision: 0, phases: {}, active: null });
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).tutorial.revision).toBe(0);
    } finally {
      unblock();
      spy.mockRestore();
    }
  });
});
