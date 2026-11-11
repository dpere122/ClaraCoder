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

function setup() {
  const electron = {
    llamaServerLifecycle$: new Subject<unknown>(),
    llamaServerProcessExit$: new Subject<unknown>(),
    llamaServerStatus: vi.fn(async () => ({ ok: true, running: false, starting: false })),
    llamaServerStart: vi.fn(async (): Promise<LlamaServerStartResult> => ({ ok: false, error: FAILED })),
    llamaServerStop: vi.fn(async () => ({ ok: true as const })),
    modelManagerListCustomModels: vi.fn(async () => ({ ok: true, models: [] })),
    setActiveLlmModel: vi.fn(async () => undefined),
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
