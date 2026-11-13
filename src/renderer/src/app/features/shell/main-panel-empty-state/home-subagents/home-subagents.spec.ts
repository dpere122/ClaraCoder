import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, LlamaServerLifecycleEvent, LlamaServerProcessExitEvent } from '@shared/index';
import { newSubagentRole, type SubagentRoleConfig } from '@shared/subagents-config';
import { ElectronService } from '../../../../core/electron.service';
import { HomeSubagentsComponent } from './home-subagents';

function provider(id: string, kind: string, name: string, runCommand = '') {
  return {
    id,
    name,
    provider: kind,
    baseUrl: '',
    apiKey: '',
    models: [
      {
        id: `conn-${id}`,
        name,
        model: `${id}-model`,
        optimizationPreset: 'generic',
        ...(runCommand ? { llamaCppManaged: { chatRunCommand: runCommand } } : {}),
      },
    ],
  };
}

function config(roles: SubagentRoleConfig[], patch: Record<string, unknown> = {}): AppConfig {
  return {
    activeLlmModelId: 'conn-claude',
    llmProviders: [
      provider('claude', 'anthropic', 'Claude'),
      provider('lm', 'lmstudio', 'LM Studio'),
      provider('gguf', 'llamacpp', 'Local GGUF', 'llama-server -m model.gguf'),
    ],
    modelManager: { customModelsDir: '' },
    subagents: { enabled: true, cloudConcurrency: 3, fallback: 'main', roles },
    ...patch,
  } as unknown as AppConfig;
}

function role(id: string, name: string, patch: Partial<SubagentRoleConfig> = {}): SubagentRoleConfig {
  return { ...newSubagentRole(id, name), ...patch };
}

function setup(appConfig: AppConfig | null, options: { unreachable?: string[]; running?: string[] } = {}) {
  const lifecycle = new Subject<LlamaServerLifecycleEvent>();
  const processExit = new Subject<LlamaServerProcessExitEvent>();
  const electron = {
    llamaServerLifecycle$: lifecycle.asObservable(),
    llamaServerProcessExit$: processExit.asObservable(),
    llamaServerStatus: vi.fn(async ({ modelId }: { modelId: string }) => ({
      ok: true,
      running: options.running?.includes(modelId) ?? false,
      modelId,
      chat: { port: 0, health: 'stopped' },
    })),
    llmSourcePing: vi.fn(async ({ modelId }: { modelId: string }) =>
      options.unreachable?.includes(modelId) ? { ok: false, error: 'unreachable' } : { ok: true },
    ),
    modelManagerListCustomModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
  };
  TestBed.configureTestingModule({
    imports: [HomeSubagentsComponent],
    providers: [{ provide: ElectronService, useValue: electron }],
  });
  const fixture = TestBed.createComponent(HomeSubagentsComponent);
  fixture.componentRef.setInput('appConfig', appConfig);
  const host = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  };
  const rows = () =>
    [...host.querySelectorAll('.home-subagents__row')].map((row) => {
      const light = row.querySelector('.home-subagents__light')!;
      const state = light.classList.contains('is-running') ? 'green' : light.classList.contains('is-loading') ? 'yellow' : 'grey';
      return [
        row.querySelector('dt')?.textContent?.trim(),
        row.querySelector('.home-subagents__source')?.textContent?.trim(),
        state,
        light.getAttribute('aria-label'),
      ];
    });
  return { fixture, host, electron, lifecycle, processExit, refresh, rows };
}

describe('HomeSubagentsComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows each enabled role with one light for its source', async () => {
    const { rows, electron, refresh } = setup(
      config([
        role('r1', 'explorer', { connectionId: 'gguf' }),
        role('r2', 'worker'),
        role('r3', 'reviewer', { connectionId: 'lm' }),
        role('r4', 'tester', { enabled: false }),
        role('r5', 'orphan', { connectionId: 'gone' }),
      ]),
      { unreachable: ['conn-lm'] },
    );
    await refresh();

    expect(rows()).toEqual([
      // A local server that is not running.
      ['explorer', 'Local GGUF', 'grey', 'Server off'],
      // No source of its own: the main agent's, which answers.
      ['worker', 'Claude', 'green', 'Connected'],
      ['reviewer', 'LM Studio', 'grey', 'Not connected'],
      ['orphan', 'Source removed', 'grey', 'Source removed'],
    ]);
    // A local server is asked for its state; only the other sources in use are pinged, once each.
    expect(electron.llamaServerStatus.mock.calls.map(([payload]) => payload.modelId)).toEqual(['conn-gguf']);
    expect(electron.llmSourcePing.mock.calls.map(([payload]) => payload.modelId).sort()).toEqual(['conn-claude', 'conn-lm']);
  });

  it('follows a local server as it loads, runs and exits', async () => {
    const { rows, lifecycle, processExit, refresh } = setup(config([role('r1', 'explorer', { connectionId: 'gguf' })]));
    await refresh();
    const light = () => rows()[0].slice(2);
    expect(light()).toEqual(['grey', 'Server off']);

    lifecycle.next({ phase: 'starting', modelId: 'conn-gguf' });
    await refresh();
    expect(light()).toEqual(['yellow', 'Server loading']);

    lifecycle.next({ phase: 'running', modelId: 'conn-gguf' });
    await refresh();
    expect(light()).toEqual(['green', 'Server running']);

    processExit.next({ modelId: 'conn-gguf', stream: 'chat', code: 1, signal: null });
    await refresh();
    expect(light()).toEqual(['grey', 'Server off']);
  });

  it('shows a server that was already running', async () => {
    const { rows, refresh } = setup(config([role('r1', 'explorer', { connectionId: 'gguf' })]), { running: ['conn-gguf'] });
    await refresh();
    expect(rows()).toEqual([['explorer', 'Local GGUF', 'green', 'Server running']]);
  });

  it('is yellow while a source is still being asked', async () => {
    const { rows, electron, fixture } = setup(config([role('r1', 'worker')]));
    electron.llmSourcePing.mockReturnValue(new Promise(() => undefined));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(rows()).toEqual([['worker', 'Claude', 'yellow', 'Checking']]);
  });

  it('asks again when the main source changes', async () => {
    const { rows, electron, fixture, refresh } = setup(config([role('r1', 'worker')]), { unreachable: ['conn-lm'] });
    await refresh();
    expect(rows()).toEqual([['worker', 'Claude', 'green', 'Connected']]);

    fixture.componentRef.setInput('appConfig', config([role('r1', 'worker')], { activeLlmModelId: 'conn-lm' }));
    await refresh();
    expect(rows()).toEqual([['worker', 'LM Studio', 'grey', 'Not connected']]);
    expect(electron.llmSourcePing).toHaveBeenCalledTimes(2);
  });

  it('says when there are no roles, and offers the way to add one', async () => {
    const { host, fixture, refresh } = setup(config([]));
    const opened = vi.fn();
    fixture.componentInstance.openSettings.subscribe(opened);
    await refresh();
    expect(host.querySelector('.home-subagents__note')?.textContent).toContain('No roles yet.');
    (host.querySelector('.home-subagents__link') as HTMLButtonElement).click();
    expect(opened).toHaveBeenCalledOnce();
  });

  it('says when subagents are off, and asks main nothing', async () => {
    const { host, electron, refresh } = setup(
      config([role('r1', 'worker')], { subagents: { enabled: false, cloudConcurrency: 3, fallback: 'main', roles: [role('r1', 'worker')] } }),
    );
    await refresh();
    expect(host.querySelector('.home-subagents__note')?.textContent?.trim()).toBe('Subagents are off.');
    expect(host.querySelector('.home-subagents__row')).toBeNull();
    expect(electron.llmSourcePing).not.toHaveBeenCalled();
  });

  it('renders nothing to ask about before the config arrives', async () => {
    const { host, electron, refresh } = setup(null);
    await refresh();
    expect(host.querySelector('.home-subagents__note')?.textContent).toContain('No roles yet.');
    expect(electron.llmSourcePing).not.toHaveBeenCalled();
  });
});
