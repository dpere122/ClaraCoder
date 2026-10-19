import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  ConversationMessage,
  LlamaServerLifecycleEvent,
  LlamaServerStatusResult,
} from '@shared/index';
import {
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  PINNED_LM_STUDIO_PROVIDER_ID,
  SecretValue,
} from '@shared/index';
import { lucideAppProviders } from '../../../lucide-setup';
import { ElectronService } from '../../../core/electron.service';
import { ConversationSessionService } from '../../shell/conversation-session.service';
import { GenerationRateService, type LiveGenerationRate } from '../chat-box/generation-rate';
import { MessageBox } from './message-box';

function localLlamaConfig(modelId = 'local-model'): AppConfig {
  return {
    activeLlmModelId: modelId,
    llmProviders: [
      {
        id: PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
        name: 'Local llama.cpp',
        provider: 'llamacpp',
        baseUrl: '',
        apiKey: SecretValue.of(''),
        models: [
          {
            id: modelId,
            name: 'Local',
            model: 'local',
            contextWindowTokens: 8192,
            thinkingMode: 'default',
            samplingPreset: 'provider-default',
            architectureHint: 'auto',
            temperature: 0,
            parallelToolCalls: false,
            optimizationPreset: 'generic',
            maxOutputTokens: 0,
            llamaCppManaged: { chatRunCommand: 'llama-server --port {{PORT}}', embeddingRunCommand: '' },
          },
        ],
      },
    ],
  } as unknown as AppConfig;
}

function openaiConfig(): AppConfig {
  return {
    activeLlmModelId: 'gpt',
    llmProviders: [
      {
        id: PINNED_LM_STUDIO_PROVIDER_ID,
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: '',
        apiKey: SecretValue.of(''),
        models: [
          {
            id: 'gpt',
            name: 'GPT',
            model: 'gpt-4o-mini',
            contextWindowTokens: 128_000,
            thinkingMode: 'default',
            samplingPreset: 'provider-default',
            architectureHint: 'auto',
            temperature: 0,
            parallelToolCalls: false,
            optimizationPreset: 'generic',
            maxOutputTokens: 0,
          },
        ],
      },
    ],
  } as unknown as AppConfig;
}

describe('MessageBox', () => {
  const lifecycleSubject = new Subject<LlamaServerLifecycleEvent>();
  const processExitSubject = new Subject<{
    modelId: string;
    stream: 'chat' | 'embed';
    code: number | null;
    signal: string | null;
  }>();
  const llamaServerStatus = vi.fn(
    async (): Promise<LlamaServerStatusResult> => ({
      ok: true,
      running: false,
      modelId: 'local-model',
      chat: { port: 0, health: 'stopped' },
    }),
  );

  const sessionMessages = signal<ConversationMessage[]>([]);
  const liveRates = signal<Record<string, LiveGenerationRate>>({});

  beforeEach(() => {
    sessionMessages.set([]);
    liveRates.set({});
    llamaServerStatus.mockReset();
    llamaServerStatus.mockResolvedValue({
      ok: true,
      running: false,
      modelId: 'local-model',
      chat: { port: 0, health: 'stopped' },
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [MessageBox],
      providers: [
        provideNoopAnimations(),
        ...lucideAppProviders,
        {
          provide: ElectronService,
          useValue: {
            chatTemplateReasoning$: new BehaviorSubject({}).asObservable(),
            llamaServerLifecycle$: lifecycleSubject.asObservable(),
            llamaServerProcessExit$: processExitSubject.asObservable(),
            llamaServerStatus,
            refreshChatTemplateReasoning: vi.fn(async () => null),
          },
        },
        {
          provide: ConversationSessionService,
          useValue: { activeConversationId: signal('conv-1'), messages: sessionMessages },
        },
        { provide: GenerationRateService, useValue: { live: liveRates } },
      ],
    });
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('disables Send when the local llama-server is not running', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', localLlamaConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Start the local llama-server to send');
  });

  it('enables Send when the local llama-server is running', async () => {
    llamaServerStatus.mockResolvedValue({
      ok: true,
      running: true,
      modelId: 'local-model',
      chat: { port: 8080, health: 'ok' },
    });
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', localLlamaConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('keeps Send enabled for a non-llama source with a resolvable connection', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('shows the live tok/s while loading and the last saved turn dimmed afterwards', async () => {
    sessionMessages.set([
      { role: 'assistant', text: 'Hi', generation: { outputTokens: 341, generationMs: 2657 } },
    ]);
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const rate = () => root.querySelector('.composer-token-rate');
    const value = () => root.querySelector('.composer-token-rate__value')?.textContent?.trim();

    expect(value()).toBe('128');
    expect(rate()?.classList.contains('composer-token-rate--idle')).toBe(true);

    // Before the first chunk of a new turn there is nothing live to show.
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(rate()).toBeNull();

    liveRates.set({ 'conv-1': { tokensPerSecond: 42.34, estimated: true } });
    fixture.detectChanges();
    expect(value()).toBe('~42.3');
    expect(rate()?.classList.contains('composer-token-rate--idle')).toBe(false);
  });

  it('renders Auto Run and Admin as toggle chips in agent mode', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.componentInstance.composerMode.set('agent');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const auto = root.querySelector('.composer-chip--auto') as HTMLButtonElement;
    const admin = root.querySelector('.composer-chip--admin') as HTMLButtonElement;
    expect(auto).toBeTruthy();
    expect(admin).toBeTruthy();
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    expect(admin.getAttribute('aria-pressed')).toBe('false');

    const grantSpy = vi.fn();
    fixture.componentInstance.adminGrantRequested.subscribe(grantSpy);
    auto.click();
    admin.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.autoApplyMode()).toBe(true);
    expect(fixture.componentInstance.adminElevationGranted()).toBe(false);
    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(admin.getAttribute('aria-pressed')).toBe('false');

    fixture.componentInstance.adminElevationGranted.set(true);
    fixture.detectChanges();
    expect(admin.getAttribute('aria-pressed')).toBe('true');
    admin.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.adminElevationGranted()).toBe(false);
  });

  it('disables Send when no LLM source is selected', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', { activeLlmModelId: '', llmProviders: [] } as unknown as AppConfig);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('No LLM source selected');
  });

  it('shows Stop while loading and emits abort when the llama-server stops', async () => {
    llamaServerStatus.mockResolvedValue({
      ok: true,
      running: true,
      modelId: 'local-model',
      chat: { port: 8080, health: 'ok' },
    });
    const fixture = TestBed.createComponent(MessageBox);
    const abortSpy = vi.fn();
    fixture.componentInstance.abortRequested.subscribe(abortSpy);
    fixture.componentRef.setInput('appConfig', localLlamaConfig());
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.btn-abort')).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).querySelector('.btn-send')).toBeNull();

    lifecycleSubject.next({ phase: 'stopped', modelId: 'local-model' });
    fixture.detectChanges();
    expect(abortSpy).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('loading', false);
    fixture.detectChanges();
    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(true);
  });
});
