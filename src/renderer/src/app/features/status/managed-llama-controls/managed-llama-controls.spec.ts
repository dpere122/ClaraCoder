import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PINNED_LM_STUDIO_PROVIDER_ID, type AppConfig, type LlamaServerStartResult } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { ManagedLlamaControlsComponent } from './managed-llama-controls';

const model = (id: string) => ({
  id,
  name: id,
  model: id,
  llamaCppManaged: { chatRunCommand: 'llama-server --port {{PORT}} -m /m.gguf', embeddingRunCommand: '' },
});
const CLOUD = { id: 'cloud', name: 'Cloud', provider: 'openai', baseUrl: '', apiKey: {}, models: [{ id: 'm9', name: 'm9', model: 'm9' }] };

const CONFIG = {
  activeLlmModelId: 'm1',
  llmProviders: [
    { id: 'a', name: 'A', provider: 'llamacpp', baseUrl: '', apiKey: {}, models: [model('m1')] },
    { id: 'b', name: 'B', provider: 'llamacpp', baseUrl: '', apiKey: {}, models: [model('m2')] },
  ],
  modelManager: { customModelsDir: '' },
} as unknown as AppConfig;
const FAILED = 'Chat llama-server process ended (exit 1).\nLast output:\nsrv load_model: failed to load model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** `running`: model ids of local servers that are up. `unreachable`: model ids whose connection check fails. */
function setup(options: { running?: string[]; unreachable?: string[] } = {}) {
  const electron = {
    llamaServerLifecycle$: new Subject<unknown>(),
    llamaServerProcessExit$: new Subject<unknown>(),
    llamaServerStatus: vi.fn(async ({ modelId }: { modelId: string }) => ({
      ok: true,
      running: options.running?.includes(modelId) ?? false,
      starting: false,
    })),
    llmSourcePing: vi.fn(async ({ modelId }: { modelId: string }) =>
      options.unreachable?.includes(modelId) ? { ok: false, error: 'down' } : { ok: true },
    ),
    llamaServerStart: vi.fn(async (): Promise<LlamaServerStartResult> => ({ ok: false, error: FAILED })),
    llamaServerStop: vi.fn(async () => ({ ok: true as const })),
    modelManagerListCustomModels: vi.fn(async () => ({ ok: true, models: [] })),
    setActiveLlmModel: vi.fn(async (): Promise<AppConfig | undefined> => undefined),
  };
  TestBed.configureTestingModule({
    imports: [ManagedLlamaControlsComponent],
    providers: [{ provide: ElectronService, useValue: electron }],
  });
  const fixture = TestBed.createComponent(ManagedLlamaControlsComponent);
  fixture.componentRef.setInput('appConfig', CONFIG);
  return { fixture, electron };
}

async function render(fixture: ComponentFixture<ManagedLlamaControlsComponent>): Promise<HTMLElement> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const button = (el: HTMLElement) => el.querySelector('.managed-llama-controls__btn') as HTMLButtonElement;
const alertText = (el: HTMLElement) => el.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => TestBed.resetTestingModule());

describe('the source menu', () => {
  it('lists custom sources in their own section after the pinned rows', async () => {
    const { fixture } = setup();
    const pinned = { id: PINNED_LM_STUDIO_PROVIDER_ID, name: 'LM Studio', provider: 'lmstudio', baseUrl: '', apiKey: {}, models: [model('m3')] };
    fixture.componentRef.setInput('appConfig', { ...CONFIG, llmProviders: [...CONFIG.llmProviders, pinned] });
    await render(fixture);
    const select = fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent;
    const options = select.options() as ReadonlyArray<{ id: string; group: string }>;
    expect(options.map((o) => [o.id, o.group])).toEqual([
      [PINNED_LM_STUDIO_PROVIDER_ID, ''],
      ['a', 'Custom'],
      ['b', 'Custom'],
    ]);
  });
});

describe('swapping the main model in the status bar', () => {
  const WITH_CLOUD = { ...CONFIG, llmProviders: [...CONFIG.llmProviders, CLOUD] } as unknown as AppConfig;

  async function statusBar(config: AppConfig, options: { running?: string[]; unreachable?: string[] } = {}) {
    const { fixture, electron } = setup(options);
    fixture.componentRef.setInput('appConfig', config);
    fixture.componentRef.setInput('layout', 'status-bar');
    const settle = async () => {
      for (let pass = 0; pass < 2; pass += 1) {
        await render(fixture);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return render(fixture);
    };
    const el = await settle();
    const select = fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent;
    const optionIds = () => (select.options() as ReadonlyArray<{ id: string }>).map((o) => o.id);
    return { fixture, electron, el, select, optionIds, settle };
  }

  it('offers sources that would answer now, every local model it can start, and always the active one', async () => {
    // Active a: stopped. b: running. cloud: fails its connection check.
    const down = await statusBar(WITH_CLOUD, { running: ['m2'], unreachable: ['m9'] });
    expect(down.optionIds()).toEqual(['a', 'b']);

    TestBed.resetTestingModule();
    const up = await statusBar(WITH_CLOUD);
    // b is stopped now, but can be started; the cloud source answers.
    expect(up.optionIds()).toEqual(['cloud', 'a', 'b']);
  });

  it('leaves out a local model with no run command when it does not answer', async () => {
    const bare = { id: 'c', name: 'C', provider: 'llamacpp', baseUrl: '', apiKey: {}, models: [{ id: 'm5', name: 'm5', model: 'm5' }] };
    const { optionIds } = await statusBar({ ...CONFIG, llmProviders: [...CONFIG.llmProviders, bare] } as unknown as AppConfig, {
      unreachable: ['m5'],
    });
    expect(optionIds()).toEqual(['a', 'b']);
  });

  it('reads Start for a stopped local model, which it makes active and starts', async () => {
    const { el, electron, select, settle } = await statusBar(CONFIG);
    select.valueChange.emit('b');
    await settle();
    expect(electron.setActiveLlmModel).not.toHaveBeenCalled();
    expect(button(el).textContent?.trim()).toBe('Start');
    expect(button(el).classList.contains('action-button--danger')).toBe(false);
    expect(button(el).disabled).toBe(false);

    button(el).click();
    await settle();
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m2');
    expect(electron.llamaServerStart).toHaveBeenCalledTimes(1);
    expect(electron.llamaServerStart.mock.calls[0]).toEqual([expect.objectContaining({ modelId: 'm2' })]);
  });

  it('starts the picked model once when Start is clicked twice before the switch lands', async () => {
    const { el, electron, select, settle } = await statusBar(CONFIG);
    const switched = deferred<AppConfig | undefined>();
    electron.setActiveLlmModel.mockReturnValueOnce(switched.promise);
    select.valueChange.emit('b');
    await settle();

    button(el).click();
    await settle();
    expect(button(el).disabled).toBe(true);
    button(el).click();
    switched.resolve({ ...CONFIG, activeLlmModelId: 'm2' } as AppConfig);
    await settle();

    expect(electron.setActiveLlmModel).toHaveBeenCalledTimes(1);
    expect(electron.llamaServerStart).toHaveBeenCalledTimes(1);
    expect(electron.llamaServerStart.mock.calls[0]).toEqual([
      expect.objectContaining({ modelId: 'm2', config: expect.objectContaining({ activeLlmModelId: 'm2' }) }),
    ]);
    expect(button(el).disabled).toBe(false);
  });

  it('starts a stopped local model while the active one runs, leaving that one up', async () => {
    const { el, electron, select, settle } = await statusBar(CONFIG, { running: ['m1'] });
    select.valueChange.emit('b');
    await settle();
    expect(button(el).textContent?.trim()).toBe('Start');
    button(el).click();
    await settle();
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m2');
    expect(electron.llamaServerStart.mock.calls[0]).toEqual([expect.objectContaining({ modelId: 'm2' })]);
    expect(electron.llamaServerStop).not.toHaveBeenCalled();
  });

  it('reads Switch for a local model whose server already runs', async () => {
    const { el, electron, select, settle } = await statusBar(CONFIG, { running: ['m2'] });
    select.valueChange.emit('b');
    await settle();
    expect(button(el).textContent?.trim()).toBe('Switch');
    button(el).click();
    await settle();
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m2');
    expect(electron.llamaServerStart).not.toHaveBeenCalled();
  });

  it('picks without switching, then switches from a red Switch button', async () => {
    const { el, electron, select, settle } = await statusBar(WITH_CLOUD);
    expect(button(el).textContent?.trim()).toBe('Start');
    expect(button(el).classList.contains('action-button--danger')).toBe(false);

    select.valueChange.emit('cloud');
    await settle();
    expect(electron.setActiveLlmModel).not.toHaveBeenCalled();
    expect(select.value()).toBe('cloud');
    expect(button(el).textContent?.trim()).toBe('Switch');
    expect(button(el).classList.contains('action-button--danger')).toBe(true);
    expect(button(el).disabled).toBe(false);

    button(el).click();
    await settle();
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m9');
    expect(electron.llamaServerStart).not.toHaveBeenCalled();
  });

  it('goes back to the server button when the active source is picked again or becomes active', async () => {
    const { el, fixture, select, settle } = await statusBar(WITH_CLOUD);
    select.valueChange.emit('cloud');
    await settle();
    select.valueChange.emit('a');
    await settle();
    expect(button(el).textContent?.trim()).toBe('Start');
    expect(select.value()).toBe('a');

    // The switch landed: cloud is active, a hosted source with no server button.
    select.valueChange.emit('cloud');
    await settle();
    fixture.componentRef.setInput('appConfig', { ...WITH_CLOUD, activeLlmModelId: 'm9' });
    await settle();
    expect(select.value()).toBe('cloud');
    expect(button(el)?.textContent?.trim()).not.toBe('Switch');
  });

  it('lets the model be swapped while the active local server runs', async () => {
    const { el, electron, select, settle } = await statusBar(WITH_CLOUD, { running: ['m1'] });
    expect(button(el).textContent?.trim()).toBe('Stop');
    expect(select.disabled()).toBe(false);

    select.valueChange.emit('cloud');
    await settle();
    expect(button(el).textContent?.trim()).toBe('Switch');
    button(el).click();
    await settle();
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m9');
    expect(electron.llamaServerStop).not.toHaveBeenCalled();
  });

  it('marks each local source whose server runs, and follows servers coming up and going down', async () => {
    const { electron, select, settle } = await statusBar(WITH_CLOUD, { running: ['m2'] });
    const lit = () =>
      (select.options() as ReadonlyArray<{ id: string; indicator?: string }>)
        .filter((o) => o.indicator === 'running')
        .map((o) => o.id);
    // The cloud source answers too, but only a local server gets the light.
    expect(lit()).toEqual(['b']);

    const lifecycle = electron.llamaServerLifecycle$ as Subject<unknown>;
    lifecycle.next({ phase: 'running', modelId: 'm1' });
    await settle();
    expect(lit()).toEqual(['a', 'b']);

    lifecycle.next({ phase: 'stopped', modelId: 'm2' });
    await settle();
    expect(lit()).toEqual(['a']);
  });

  it('draws the light in the open menu', async () => {
    const { el, select, settle } = await statusBar(CONFIG, { running: ['m2'] });
    expect(select.options().length).toBe(2);
    (el.querySelector('.pill-select__trigger') as HTMLButtonElement).click();
    await settle();
    const rows = [...document.querySelectorAll('.pill-select__option')].map((row) => ({
      label: row.querySelector('.pill-select__option-label')?.textContent?.trim(),
      running: row.querySelector('.pill-select__indicator.is-running')?.getAttribute('aria-label') ?? null,
    }));
    expect(rows).toEqual([
      { label: 'A', running: null },
      { label: 'B', running: 'Running' },
    ]);
  });

  it('follows a local server that comes up later: Start turns into Switch', async () => {
    const { el, electron, select, settle } = await statusBar(CONFIG);
    select.valueChange.emit('b');
    await settle();
    expect(button(el).textContent?.trim()).toBe('Start');
    (electron.llamaServerLifecycle$ as Subject<unknown>).next({ phase: 'running', modelId: 'm2' });
    await settle();
    expect(button(el).textContent?.trim()).toBe('Switch');
  });

  it('leaves the home page as it was: every source listed, and a pick switches at once', async () => {
    const { fixture, electron } = setup({ unreachable: ['m9'] });
    fixture.componentRef.setInput('appConfig', WITH_CLOUD);
    const el = await render(fixture);
    const select = fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent;
    expect((select.options() as ReadonlyArray<{ id: string }>).map((o) => o.id)).toEqual(['cloud', 'a', 'b']);
    expect(electron.llmSourcePing).not.toHaveBeenCalled();
    expect((select.options() as ReadonlyArray<{ indicator?: string }>).some((o) => o.indicator)).toBe(false);

    select.valueChange.emit('b');
    await render(fixture);
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m2');
    expect(button(el).textContent?.trim()).toBe('Start');
  });

  it('marks running local sources on the home page too, asking only for local server state', async () => {
    const { fixture, electron } = setup({ running: ['m2'] });
    fixture.componentRef.setInput('appConfig', WITH_CLOUD);
    for (let pass = 0; pass < 3; pass += 1) {
      await render(fixture);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const select = fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent;
    const lit = (select.options() as ReadonlyArray<{ id: string; indicator?: string }>)
      .filter((o) => o.indicator === 'running')
      .map((o) => o.id);
    expect(lit).toEqual(['b']);
    expect(electron.llmSourcePing).not.toHaveBeenCalled();
  });
});

describe('the layout', () => {
  it('is compact only when asked for the status bar', async () => {
    const { fixture } = setup();
    const el = await render(fixture);
    expect(el.querySelector('.managed-llama-controls--status-bar')).toBeNull();
    fixture.componentRef.setInput('layout', 'status-bar');
    await render(fixture);
    expect(el.querySelector('.managed-llama-controls--status-bar')).toBeTruthy();
  });

  it('widens the source menu to its longest name only in the status bar', async () => {
    const { fixture } = setup();
    await render(fixture);
    const select = fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent;
    expect(select.menuFitContent()).toBe(false);
    fixture.componentRef.setInput('layout', 'status-bar');
    await render(fixture);
    expect(select.menuFitContent()).toBe(true);
  });
});

describe('a start that fails', () => {
  const failedStart = async (layout: 'default' | 'status-bar' = 'default') => {
    const { fixture, electron } = setup();
    fixture.componentRef.setInput('layout', layout);
    const el = await render(fixture);
    button(el).click();
    await render(fixture);
    expect(alertText(el)).toContain('failed to load model');
    return { fixture, electron, el };
  };

  it('can be dismissed in the status bar, where it covers what is above the bar', async () => {
    const { fixture, el } = await failedStart('status-bar');
    (el.querySelector('.managed-llama-controls__error-dismiss') as HTMLButtonElement).click();
    await render(fixture);
    expect(alertText(el)).toBeNull();
    expect(el.querySelector('.managed-llama-controls__error-dismiss')).toBeNull();
  });

  it('stays inline with no dismiss button outside the status bar', async () => {
    const { el } = await failedStart();
    expect(el.querySelector('.managed-llama-controls__error-dismiss')).toBeNull();
  });

  it('goes away when another source becomes active from outside this control', async () => {
    const { fixture, el } = await failedStart();
    fixture.componentRef.setInput('appConfig', { ...CONFIG, activeLlmModelId: 'm2' });
    await render(fixture);
    expect(alertText(el)).toBeNull();
  });

  it('stays when the config is re-sent for the same source', async () => {
    const { fixture, el } = await failedStart();
    fixture.componentRef.setInput('appConfig', { ...CONFIG });
    await render(fixture);
    expect(alertText(el)).toContain('failed to load model');
  });

  it('goes away when the server comes up some other way', async () => {
    const { fixture, electron, el } = await failedStart();
    electron.llamaServerLifecycle$.next({ modelId: 'm1', phase: 'running' });
    await render(fixture);
    expect(alertText(el)).toBeNull();
  });

  it('says what the server said, and goes back to Start', async () => {
    const { fixture } = setup();
    const el = await render(fixture);
    expect(alertText(el)).toBeNull();
    button(el).click();
    await render(fixture);
    expect(alertText(el)).toContain('failed to load model');
    expect(button(el).textContent).toContain('Start');
  });

  it('says nothing when the user cancelled it', async () => {
    const { fixture, electron } = setup();
    const start = deferred<LlamaServerStartResult>();
    electron.llamaServerStart.mockReturnValue(start.promise);
    const el = await render(fixture);
    button(el).click();
    fixture.detectChanges();
    expect(button(el).textContent).toContain('Cancel');
    button(el).click();
    await vi.waitFor(() => expect(electron.llamaServerStop).toHaveBeenCalled());
    start.resolve({ ok: false, error: 'Managed servers were stopped.' });
    await render(fixture);
    expect(alertText(el)).toBeNull();
    expect(button(el).textContent).toContain('Start');
  });

  it('is cleared by the next start, and speaks again if that one fails after an earlier cancel', async () => {
    const { fixture, electron } = setup();
    const el = await render(fixture);
    const start = deferred<LlamaServerStartResult>();
    electron.llamaServerStart.mockReturnValueOnce(start.promise);
    button(el).click();
    fixture.detectChanges();
    button(el).click();
    await vi.waitFor(() => expect(electron.llamaServerStop).toHaveBeenCalled());
    start.resolve({ ok: false, error: 'Managed servers were stopped.' });
    await render(fixture);

    button(el).click();
    await render(fixture);
    expect(alertText(el)).toContain('failed to load model');

    const next = deferred<LlamaServerStartResult>();
    electron.llamaServerStart.mockReturnValueOnce(next.promise);
    button(el).click();
    fixture.detectChanges();
    expect(alertText(el)).toBeNull();
    next.resolve({ ok: true });
    await render(fixture);
    expect(alertText(el)).toBeNull();
  });

  it('is cleared by choosing another source', async () => {
    const { fixture, electron } = setup();
    const el = await render(fixture);
    button(el).click();
    await render(fixture);
    expect(alertText(el)).not.toBeNull();
    (fixture.debugElement.query(By.directive(PillSelectComponent)).componentInstance as PillSelectComponent).valueChange.emit('b');
    await render(fixture);
    expect(electron.setActiveLlmModel).toHaveBeenCalledWith('m2');
    expect(alertText(el)).toBeNull();
  });
});
