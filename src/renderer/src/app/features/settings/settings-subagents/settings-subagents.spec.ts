import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlamaServerLifecycleEvent, LlamaServerProcessExitEvent } from '@shared/index';
import {
  defaultSubagentsConfig,
  newSubagentRole,
  type SubagentRoleConfig,
  type SubagentsConfig,
} from '@shared/subagents-config';
import { AnthropicService } from '../../../core/anthropic.service';
import { ElectronService } from '../../../core/electron.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsSubagents } from './settings-subagents';

const SOURCES = [
  { id: 'src-claude', connectionId: 'conn-claude', label: 'Claude', provider: 'anthropic', model: 'claude-main', preset: 'generic', local: false, launchable: false, saved: true },
  { id: 'src-lm', connectionId: 'conn-lm', label: 'LM Studio', provider: 'lmstudio', model: 'qwen', preset: 'qwen', local: true, launchable: false, saved: true },
  { id: 'src-llama', connectionId: 'conn-llama', label: 'Local GGUF', provider: 'llamacpp', model: 'gguf', preset: 'gemma', local: true, launchable: true, saved: true },
];
const SAVED_CONFIG = { marker: 'saved config' };

type SetupOptions = {
  /** Connection ids whose ping fails (no key, unreachable). */
  unreachable?: string[];
  /** Connection ids of local servers already running. */
  running?: string[];
  sources?: typeof SOURCES;
};

function setup(roles: SubagentRoleConfig[] = [], options: SetupOptions = {}) {
  const lifecycle = new Subject<LlamaServerLifecycleEvent>();
  const processExit = new Subject<LlamaServerProcessExitEvent>();
  const electron = {
    llamaServerLifecycle$: lifecycle.asObservable(),
    llamaServerProcessExit$: processExit.asObservable(),
    llamaServerStart: vi.fn().mockResolvedValue({ ok: true }),
    llamaServerStop: vi.fn().mockResolvedValue({ ok: true }),
    llamaServerStatus: vi.fn(async ({ modelId }: { modelId: string }) => ({
      ok: true,
      running: options.running?.includes(modelId) ?? false,
      modelId,
      chat: { port: 0, health: 'stopped' },
    })),
    llmSourcePing: vi.fn(async ({ modelId }: { modelId: string }) =>
      options.unreachable?.includes(modelId) ? { ok: false, error: 'no key' } : { ok: true },
    ),
  };
  const subagents = signal<SubagentsConfig>({ ...defaultSubagentsConfig(), roles });
  const selectedSubagentRoleId = signal('');
  const patchRole = (id: string, patch: Partial<SubagentRoleConfig>) =>
    subagents.update((current) => ({
      ...current,
      roles: current.roles.map((role) => (role.id === id ? { ...role, ...patch } : role)),
    }));
  const store = {
    subagents,
    selectedSubagentRoleId,
    selectedSubagentRole: computed(
      () => subagents().roles.find((role) => role.id === selectedSubagentRoleId()) ?? subagents().roles[0] ?? null,
    ),
    subagentSourceOptions: () => options.sources ?? SOURCES,
    savedConfig: () => SAVED_CONFIG,
    activeLlmModelId: () => 'conn-claude',
    patchSubagents: vi.fn((patch: Partial<SubagentsConfig>) => subagents.update((current) => ({ ...current, ...patch }))),
    patchSubagentRole: vi.fn(patchRole),
    addSubagentRole: vi.fn(),
    removeSubagentRole: vi.fn(),
  };
  const confirm = { open: vi.fn().mockResolvedValue('confirm') };
  const claude = {
    models: () => [
      { id: 'claude-small', displayName: 'Claude Small', line: 'haiku', deprecated: false, effortLevels: ['low', 'medium'] },
      { id: 'claude-main', displayName: 'Claude Main', line: 'opus', deprecated: false, effortLevels: ['low', 'high', 'max'] },
    ],
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    imports: [SettingsSubagents],
    providers: [
      { provide: SettingsStore, useValue: store },
      { provide: ThemedConfirmDialogService, useValue: confirm },
      { provide: AnthropicService, useValue: claude },
      { provide: ElectronService, useValue: electron },
    ],
  });
  const fixture = TestBed.createComponent(SettingsSubagents);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  // The probes and launches settle on later ticks than the first render.
  const refresh = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  };
  return { fixture, host, store, confirm, claude, electron, lifecycle, processExit, refresh };
}

function role(id: string, name: string, patch: Partial<SubagentRoleConfig> = {}): SubagentRoleConfig {
  return { ...newSubagentRole(id, name), ...patch };
}

function fieldControl<T extends HTMLElement>(host: HTMLElement, label: string): T | null {
  const field = [...host.querySelectorAll('.settings-subagents__editor label.field')].find(
    (el) => el.querySelector('span')?.textContent?.trim() === label,
  );
  return (field?.querySelector('input, select, textarea') as T | null) ?? null;
}

describe('SettingsSubagents', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('explains the empty state and offers to add a role', async () => {
    const { host, store, refresh } = setup();
    await refresh();
    expect(host.querySelector('.settings-subagents__editor--empty')?.textContent).toContain('No roles yet');
    (host.querySelector('.settings-subagents__list-foot button') as HTMLButtonElement).click();
    expect(store.addSubagentRole).toHaveBeenCalledWith();
  });

  it('lists roles as text only and edits the selected one beside the list', async () => {
    const { host, refresh } = setup([
      role('r1', 'explorer', { connectionId: 'src-lm', model: 'tiny', readOnly: true }),
      role('r2', 'worker'),
      role('r3', 'tester', { enabled: false }),
    ]);
    await refresh();

    const rows = [...host.querySelectorAll('.settings-subagents__role')];
    expect(rows.map((row) => [...row.querySelectorAll('span')].map((s) => s.textContent?.trim()))).toEqual([
      ['explorer', 'LM Studio · tiny', 'Read only'],
      ['worker', 'Same as main agent', 'Follows chat mode'],
      ['tester', 'Same as main agent', 'Off'],
    ]);
    // The list holds no form controls: every setting has exactly one control, in the editor.
    expect(host.querySelector('.settings-subagents__list')!.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    expect(fieldControl<HTMLInputElement>(host, 'Name')?.value).toBe('explorer');

    (rows[1] as HTMLButtonElement).click();
    await refresh();
    expect(fieldControl<HTMLInputElement>(host, 'Name')?.value).toBe('worker');
  });

  it('names the other source a role sends workspace content to', async () => {
    const { host, refresh } = setup([role('r1', 'explorer', { connectionId: 'src-lm' }), role('r2', 'same', { connectionId: 'src-claude' })]);
    await refresh();
    const notice = host.querySelector('.settings-subagents__notice')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(notice).toBe(
      "Not the chat's source. Files and search results this role reads go to LM Studio, which runs on this machine.",
    );

    (host.querySelectorAll('.settings-subagents__role')[1] as HTMLButtonElement).click();
    await refresh();
    expect(host.querySelector('.settings-subagents__notice')).toBeNull();
  });

  it('flags a role whose source was removed', async () => {
    const { host, refresh } = setup([role('r1', 'explorer', { connectionId: 'gone' })]);
    await refresh();
    expect(host.querySelector('.settings-subagents__role-line.is-warning')?.textContent?.trim()).toBe('Source removed');
    expect(host.querySelector('.settings-subagents__notice')?.textContent).toContain('no longer in Sources');
  });

  it('offers a model control that fits the source', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer')]);
    await refresh();
    // Same as the main agent: it takes that source's model, so there is nothing to pick.
    expect(fieldControl(host, 'Model')).toBeNull();

    // Claude: a pick from its catalog.
    store.patchSubagentRole('r1', { connectionId: 'src-claude' });
    await refresh();
    const claudePick = fieldControl<HTMLSelectElement>(host, 'Model')!;
    expect([...claudePick.options].map((o) => o.textContent?.trim())).toEqual([
      "The source's model",
      'Claude Main',
      'Claude Small',
    ]);

    store.patchSubagentRole('r1', { connectionId: 'src-lm' });
    await refresh();
    const text = fieldControl<HTMLInputElement>(host, 'Model')!;
    expect(text.tagName).toBe('INPUT');
    expect(text.placeholder).toBe('qwen');

    // A managed llama server runs one model: nothing to pick.
    store.patchSubagentRole('r1', { connectionId: 'src-llama' });
    await refresh();
    expect(fieldControl(host, 'Model')).toBeNull();
  });

  it('sets a role\'s thinking, and names what off means on Claude', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer', { connectionId: 'src-lm' })]);
    await refresh();
    const thinking = () => fieldControl<HTMLSelectElement>(host, 'Thinking')!;
    expect(thinking().value).toBe('source');
    expect([...thinking().options].map((o) => o.textContent?.trim())).toEqual(["The source's setting", 'On', 'Off']);

    thinking().value = 'off';
    thinking().dispatchEvent(new Event('change'));
    await refresh();
    expect(store.patchSubagentRole).toHaveBeenLastCalledWith('r1', { thinking: 'off' });
    expect(thinking().value).toBe('off');

    // Claude has no off switch.
    store.patchSubagentRole('r1', { connectionId: '' });
    await refresh();
    expect([...thinking().options].map((o) => o.textContent?.trim())).toEqual([
      "The source's setting",
      'On',
      'Lowest effort',
    ]);
  });

  it('offers the thinking levels the role\'s model accepts, defaulting to the source\'s', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer', { connectionId: 'src-lm' })]);
    await refresh();
    const level = () => fieldControl<HTMLSelectElement>(host, 'Thinking level');
    const options = () => [...level()!.options].map((o) => o.textContent?.trim());

    // A Qwen preset source: its three levels.
    expect(level()!.value).toBe('');
    expect(options()).toEqual(["The source's setting", 'Low', 'Medium', 'Extra high']);
    level()!.value = 'medium';
    level()!.dispatchEvent(new Event('change'));
    await refresh();
    expect(store.patchSubagentRole).toHaveBeenLastCalledWith('r1', { thinkingLevel: 'medium' });

    // Off leaves nothing to set a level for.
    store.patchSubagentRole('r1', { thinking: 'off' });
    await refresh();
    expect(level()!.disabled).toBe(true);

    // Claude: what the role's model reports, here the source's own model and then an override.
    store.patchSubagentRole('r1', { connectionId: 'src-claude', thinking: 'source', thinkingLevel: '' });
    await refresh();
    expect(options()).toEqual(["The source's setting", 'Low', 'High', 'Max']);
    store.patchSubagentRole('r1', { model: 'claude-small' });
    await refresh();
    expect(options()).toEqual(["The source's setting", 'Low', 'Medium']);

    // A model whose thinking is only on or off has no level control.
    store.patchSubagentRole('r1', { connectionId: 'src-llama', model: '' });
    await refresh();
    expect(level()).toBeNull();
    expect(fieldControl(host, 'Thinking')).not.toBeNull();
  });

  it('clears the model when the source changes', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer', { connectionId: 'src-lm', model: 'tiny' })]);
    await refresh();
    const source = fieldControl<HTMLSelectElement>(host, 'Source')!;
    source.value = 'src-claude';
    source.dispatchEvent(new Event('change'));
    await refresh();
    expect(store.patchSubagentRole).toHaveBeenCalledWith('r1', { connectionId: 'src-claude', model: '', thinkingLevel: '' });
  });

  it('locks the Editor only tools for a read only role', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer', { readOnly: true })]);
    await refresh();
    const tools = [...host.querySelectorAll<HTMLLabelElement>('.settings-subagents__tool-list label')].map((label) => {
      const box = label.querySelector('input') as HTMLInputElement;
      return [label.textContent?.trim(), box.checked, box.disabled];
    });
    expect(tools).toEqual([
      ['Read files', true, false],
      ['Search', true, false],
      ['Language servers', true, false],
      ['Web', true, false],
      ['Run commands', false, true],
      ['MCP servers', false, true],
      ['Edit files', false, true],
    ]);

    const web = host.querySelectorAll<HTMLInputElement>('.settings-subagents__tool-list input')[3];
    web.click();
    await refresh();
    expect(store.patchSubagentRole).toHaveBeenLastCalledWith('r1', {
      tools: ['read', 'search', 'lsp', 'commands', 'mcp', 'edit'],
    });
  });

  it('refuses an empty or taken name and keeps the old one', async () => {
    const { host, store, refresh } = setup([role('r1', 'explorer'), role('r2', 'worker')]);
    await refresh();
    const name = fieldControl<HTMLInputElement>(host, 'Name')!;

    name.value = 'Worker';
    name.dispatchEvent(new Event('change'));
    await refresh();
    expect(store.patchSubagentRole).not.toHaveBeenCalled();
    expect(name.value).toBe('explorer');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('already named Worker');

    name.value = '  code   scout ';
    name.dispatchEvent(new Event('change'));
    await refresh();
    expect(store.patchSubagentRole).toHaveBeenCalledWith('r1', { name: 'code scout' });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('asks before deleting a role', async () => {
    const { host, store, confirm, refresh } = setup([role('r1', 'explorer')]);
    await refresh();
    (host.querySelector('.action-button--danger') as HTMLButtonElement).click();
    await refresh();
    expect(confirm.open).toHaveBeenCalledOnce();
    expect(store.removeSubagentRole).toHaveBeenCalledWith('r1');
  });

  it('offers every llama.cpp source, and any other only when it would answer now', async () => {
    const { host, electron, refresh } = setup(
      [role('r1', 'explorer'), role('r2', 'stale', { connectionId: 'src-lm' }), role('r3', 'local', { connectionId: 'src-llama' })],
      { unreachable: ['conn-lm'] },
    );
    await refresh();
    const sourceOptions = () => [...fieldControl<HTMLSelectElement>(host, 'Source')!.options].map((o) => o.textContent?.trim());

    // LM Studio fails its ping: not offered. The stopped local server is, marked.
    expect(sourceOptions()).toEqual(['Same as main agent', 'Claude', 'Local GGUF (not running)']);
    // The local server is asked for its state, never pinged at its saved address.
    expect(electron.llmSourcePing.mock.calls.map(([payload]) => payload.modelId).sort()).toEqual(['conn-claude', 'conn-lm']);
    expect(electron.llamaServerStatus).toHaveBeenCalledWith({ modelId: 'conn-llama', config: SAVED_CONFIG });

    // A role already on such a source keeps showing it, marked.
    const rows = host.querySelectorAll<HTMLButtonElement>('.settings-subagents__role');
    rows[1].click();
    await refresh();
    expect(sourceOptions()).toEqual(['Same as main agent', 'LM Studio (unavailable)', 'Claude', 'Local GGUF (not running)']);
    expect(fieldControl<HTMLSelectElement>(host, 'Source')!.value).toBe('src-lm');
    // A role on the stopped local server finds it in its usual place, listed once.
    rows[2].click();
    await refresh();
    expect(sourceOptions()).toEqual(['Same as main agent', 'Claude', 'Local GGUF (not running)']);
    expect(fieldControl<HTMLSelectElement>(host, 'Source')!.value).toBe('src-llama');
  });

  it('offers a llama.cpp source without a run command, marked when it does not answer', async () => {
    const pinned = { ...SOURCES[2], id: 'src-pinned', connectionId: 'conn-pinned', label: 'Pinned server', launchable: false };
    const { host, refresh } = setup([role('r1', 'explorer')], { sources: [...SOURCES, pinned], unreachable: ['conn-pinned'] });
    await refresh();
    const sourceOptions = () => [...fieldControl<HTMLSelectElement>(host, 'Source')!.options].map((o) => o.textContent?.trim());
    expect(sourceOptions()).toEqual([
      'Same as main agent',
      'Claude',
      'LM Studio',
      'Local GGUF (not running)',
      'Pinned server (unavailable)',
    ]);
  });

  it('lists local servers with one light and launches the saved command', async () => {
    const { host, electron, lifecycle, refresh } = setup([role('r1', 'explorer')]);
    await refresh();
    const row = () => host.querySelector('.settings-subagents__server')!;
    const light = () => row().querySelector('.settings-subagents__light')!;
    const button = () => row().querySelector('button') as HTMLButtonElement;
    const sourceOptions = () => [...fieldControl<HTMLSelectElement>(host, 'Source')!.options].map((o) => o.textContent?.trim());

    // Only the source with a run command is a local server.
    expect(host.querySelectorAll('.settings-subagents__server')).toHaveLength(1);
    expect(row().querySelector('.settings-subagents__server-name')?.textContent).toBe('Local GGUF');
    expect(row().querySelectorAll('.settings-subagents__light')).toHaveLength(1);
    expect([light().getAttribute('aria-label'), light().className, button().textContent?.trim()]).toEqual([
      'Off',
      'settings-subagents__light',
      'Launch',
    ]);

    button().click();
    await refresh();
    expect(electron.llamaServerStart).toHaveBeenCalledWith({ modelId: 'conn-llama', config: SAVED_CONFIG });
    expect([light().getAttribute('aria-label'), light().classList.contains('is-loading'), button().textContent?.trim()]).toEqual([
      'Loading',
      true,
      'Cancel',
    ]);
    expect(sourceOptions()).toContain('Local GGUF (not running)');

    lifecycle.next({ phase: 'running', modelId: 'conn-llama' });
    await refresh();
    expect([light().getAttribute('aria-label'), light().classList.contains('is-running'), button().textContent?.trim()]).toEqual([
      'Running',
      true,
      'Stop',
    ]);
    // Running: no longer marked.
    expect(sourceOptions()).toEqual(['Same as main agent', 'Claude', 'LM Studio', 'Local GGUF']);

    button().click();
    await refresh();
    expect(electron.llamaServerStop).toHaveBeenCalledWith({ modelId: 'conn-llama', config: SAVED_CONFIG });
    expect(light().getAttribute('aria-label')).toBe('Off');
  });

  it('shows a server that is already running and follows its exit', async () => {
    const { host, processExit, refresh } = setup([], { running: ['conn-llama'] });
    await refresh();
    const light = () => host.querySelector('.settings-subagents__light')!;
    expect(light().getAttribute('aria-label')).toBe('Running');

    processExit.next({ modelId: 'conn-llama', stream: 'chat', code: 1, signal: null });
    await refresh();
    expect(light().getAttribute('aria-label')).toBe('Off');
  });

  it('reports why a launch failed and cannot launch an unsaved source', async () => {
    const draft = { ...SOURCES[2], id: 'src-draft', connectionId: 'conn-draft', label: 'Draft GGUF', saved: false };
    const { host, electron, refresh } = setup([], { sources: [...SOURCES, draft] });
    electron.llamaServerStart.mockResolvedValue({ ok: false, error: 'model file not found' });
    await refresh();
    const buttons = host.querySelectorAll<HTMLButtonElement>('.settings-subagents__server button');
    expect(buttons[1].disabled).toBe(true);

    buttons[0].click();
    await refresh();
    expect(host.querySelector('.settings-subagents__servers [role="alert"]')?.textContent).toBe(
      'Local GGUF: model file not found',
    );
    expect(host.querySelector('.settings-subagents__light')?.getAttribute('aria-label')).toBe('Off');
  });

  it('says where to add a local model when there is none', async () => {
    const { host, refresh } = setup([], { sources: SOURCES.slice(0, 2) });
    await refresh();
    expect(host.querySelector('.settings-subagents__server--empty')?.textContent?.trim()).toBe(
      'No local models with a run command. Add one in Sources.',
    );
  });

  it('clamps the cloud limit', async () => {
    const { host, store, refresh } = setup();
    await refresh();
    const limit = host.querySelector<HTMLInputElement>('.settings-subagents__limit input')!;
    limit.value = '99';
    limit.dispatchEvent(new Event('input'));
    await refresh();
    expect(store.patchSubagents).toHaveBeenCalledWith({ cloudConcurrency: 16 });
  });
});
