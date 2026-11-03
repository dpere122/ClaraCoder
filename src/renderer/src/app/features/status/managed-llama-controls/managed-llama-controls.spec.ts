import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, LlamaServerStartResult } from '@shared/index';
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

describe('a start that fails', () => {
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
