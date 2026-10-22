import { TestBed } from '@angular/core/testing';
import type { AppConfig } from '@shared/index';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronService } from '../../../core/electron.service';
import { LlamaStatusIndicator } from './llama-status-indicator';

/** No model sources and no active model: the home screen before anything is set up. */
const noModelConfig = { llmProviders: [], activeLlmModelId: '' } as unknown as AppConfig;

describe('LlamaStatusIndicator', () => {
  let electron: {
    llamaServerLifecycle$: Subject<unknown>;
    llamaServerProcessExit$: Subject<unknown>;
    llamaServerStatus: ReturnType<typeof vi.fn>;
    embeddingsStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    electron = {
      llamaServerLifecycle$: new Subject(),
      llamaServerProcessExit$: new Subject(),
      llamaServerStatus: vi.fn(),
      embeddingsStatus: vi.fn().mockResolvedValue({ ok: true, status: 'ready' }),
    };
    TestBed.configureTestingModule({
      imports: [LlamaStatusIndicator],
      providers: [{ provide: ElectronService, useValue: electron }],
    });
  });

  async function mount(layout: 'bar' | 'rows') {
    const fixture = TestBed.createComponent(LlamaStatusIndicator);
    fixture.componentRef.setInput('layout', layout);
    fixture.componentRef.setInput('appConfig', noModelConfig);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('rows layout reports CPU embeddings status with no model selected', async () => {
    const fixture = await mount('rows');
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.llama-status-rows__text')).map(
      (el) => el.textContent?.trim(),
    );
    expect(rows).toEqual(['No model selected', 'Ready']);
    expect(electron.embeddingsStatus).toHaveBeenCalled();
    fixture.destroy();
  });

  it('bar layout stays hidden and does not poll with no model selected', async () => {
    const fixture = await mount('bar');
    expect((fixture.nativeElement as HTMLElement).querySelector('.llama-status')).toBeNull();
    expect(electron.embeddingsStatus).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
