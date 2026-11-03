import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_OPTIMIZATION_PRESET_LIST, type LlmProviderConfig } from '@shared/index';
import { AnthropicService } from '../../../core/anthropic.service';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { lucideAppProviders } from '../../../lucide-setup';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsThemesStore } from '../settings-themes/settings-themes-store';
import { SettingsModels } from './settings-models';

function setup() {
  TestBed.configureTestingModule({
    imports: [SettingsModels],
    providers: [
      ...lucideAppProviders,
      SettingsStore,
      {
        provide: ElectronService,
        useValue: { chatTemplateReasoning$: new Subject(), refreshChatTemplateReasoning: vi.fn(async () => undefined) },
      },
      { provide: AnthropicService, useValue: {} },
      { provide: ThemedConfirmDialogService, useValue: {} },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      { provide: SettingsThemesStore, useValue: { attach: vi.fn(), syncSelectionFromHost: vi.fn(), cancelPreview: vi.fn() } },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  store.llmProviders.set([
    {
      id: 'lm',
      name: 'Server',
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: {},
      models: [{ id: 'm1', name: 'model', model: 'model', contextWindowTokens: 8192, maxOutputTokens: 0 }],
    } as unknown as LlmProviderConfig,
  ]);
  store.selectedModelId.set('m1');
  return TestBed.createComponent(SettingsModels);
}

beforeEach(() => TestBed.resetTestingModule());

describe('Max output', () => {
  const TEXT = '0 uses the default limit. On llama.cpp and LM Studio that is 24,576 tokens per reply. Any other value replaces it.';

  it('says what 0 does on a local server, in the tooltip and to a screen reader', () => {
    const fixture = setup();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const help = [...el.querySelectorAll('.field-help')].find((h) => h.parentElement?.textContent?.includes('Max output'));
    expect(help?.getAttribute('aria-label')).toBe(TEXT);
    expect(help?.querySelector('[role="tooltip"]')?.textContent).toBe(TEXT);
    expect(el.querySelector<HTMLInputElement>('input[max="200000"]')?.placeholder).toBe('0 = default limit');
  });

  it('is described the same way by the Gemma template', () => {
    const gemma = LLM_OPTIMIZATION_PRESET_LIST.find((p) => p.id === 'gemma');
    expect(gemma?.description).toContain('max output 0 means a limit of 24576 tokens per reply');
    expect(gemma?.description).not.toContain('no Clara-side cap');
    expect(gemma?.providers).toEqual(['lmstudio', 'llamacpp']);
  });
});
