import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  ConversationMessage,
  LlamaServerLifecycleEvent,
  LlamaServerStatusResult,
  LlmSourcePingResult,
} from '@shared/index';
import {
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
        id: 'local-source',
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

  const llmSourcePing = vi.fn(async (): Promise<LlmSourcePingResult> => ({ ok: true }));

  const sessionMessages = signal<ConversationMessage[]>([]);
  const pendingIds = signal<Set<string>>(new Set());
  const liveRates = signal<Record<string, LiveGenerationRate>>({});
  const drainingIds = signal<ReadonlySet<string>>(new Set());

  beforeEach(() => {
    sessionMessages.set([]);
    pendingIds.set(new Set());
    llmSourcePing.mockReset();
    llmSourcePing.mockResolvedValue({ ok: true });
    drainingIds.set(new Set());
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
            llmSourcePing,
            refreshChatTemplateReasoning: vi.fn(async () => null),
          },
        },
        {
          provide: ConversationSessionService,
          useValue: {
            activeConversationId: signal('conv-1'),
            messages: sessionMessages,
            drainingConversationIds: drainingIds,
            pendingIds,
          },
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

  it('keeps Send off while a running llama-server fails its health check', async () => {
    llamaServerStatus.mockResolvedValue({
      ok: true,
      running: true,
      modelId: 'local-model',
      chat: { port: 8080, health: 'error' },
    });
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', localLlamaConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("The local llama-server isn't responding");
  });

  it('does not ping a managed llama-server: its status and lifecycle events cover it', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', localLlamaConfig());
    fixture.detectChanges();
    await flush();

    expect(llmSourcePing).not.toHaveBeenCalled();
  });

  it('holds Send until the selected source answers its first ping', async () => {
    let answer: (result: LlmSourcePingResult) => void = () => undefined;
    llmSourcePing.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Checking the connection…');

    answer({ ok: true });
    await flush();
    fixture.detectChanges();
    expect(send.disabled).toBe(false);
    expect(send.title).toBe('Send message');
  });

  it('blocks Send and Enter with the ping error when the source is unreachable', async () => {
    const error = "Can't reach LM Studio at http://127.0.0.1:1234";
    llmSourcePing.mockResolvedValue({ ok: false, error });
    const fixture = TestBed.createComponent(MessageBox);
    const sent: string[] = [];
    fixture.componentInstance.messageSent.subscribe((text) => sent.push(text));
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.componentInstance.composerDraft.set('hello');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const send = root.querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe(error);
    expect((root.querySelector('textarea.form-control') as HTMLTextAreaElement).placeholder).toBe(error);

    fixture.componentInstance.send();
    expect(sent).toEqual([]);
    expect(fixture.componentInstance.composerDraft()).toBe('hello');
  });

  it('unlocks when the window regains focus and the source came back', async () => {
    llmSourcePing.mockResolvedValue({ ok: false, error: 'down' });
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    llmSourcePing.mockResolvedValue({ ok: true });
    window.dispatchEvent(new Event('focus'));
    await flush();
    fixture.detectChanges();
    expect(send.disabled).toBe(false);
  });

  it('does not ping on focus during a turn, and re-checks when it ends', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.detectChanges();
    await flush();
    pendingIds.set(new Set(['conv-2']));
    fixture.detectChanges();
    await flush();
    llmSourcePing.mockClear();

    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(llmSourcePing).not.toHaveBeenCalled();

    pendingIds.set(new Set());
    fixture.detectChanges();
    await flush();
    expect(llmSourcePing).toHaveBeenCalledTimes(1);
  });

  it('forgets the last answer when the source changes, but not on an unrelated config change', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    const cfg = openaiConfig();
    fixture.componentRef.setInput('appConfig', cfg);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    llmSourcePing.mockReturnValue(new Promise(() => undefined));
    fixture.componentRef.setInput('appConfig', { ...cfg });
    fixture.detectChanges();
    expect(send.disabled).toBe(false);

    const provider = cfg.llmProviders[0];
    fixture.componentRef.setInput('appConfig', {
      ...cfg,
      llmProviders: [{ ...provider, baseUrl: 'http://other/v1' }],
    });
    fixture.detectChanges();
    expect(send.disabled).toBe(true);
  });

  describe('entry field', () => {
    async function setup(draft: string): Promise<{
      fixture: ComponentFixture<MessageBox>;
      field: HTMLTextAreaElement;
      sent: string[];
      press: (init: KeyboardEventInit) => KeyboardEvent;
    }> {
      const fixture = TestBed.createComponent(MessageBox);
      const sent: string[] = [];
      fixture.componentInstance.messageSent.subscribe((text) => sent.push(text));
      fixture.componentRef.setInput('appConfig', openaiConfig());
      fixture.componentInstance.composerDraft.set(draft);
      fixture.detectChanges();
      await fixture.whenStable();
      await flush();
      fixture.detectChanges();
      const field = (fixture.nativeElement as HTMLElement).querySelector('textarea.form-control') as HTMLTextAreaElement;
      const press = (init: KeyboardEventInit): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
        field.dispatchEvent(event);
        fixture.detectChanges();
        return event;
      };
      return { fixture, field, sent, press };
    }

    it('shows an arrow instead of the SEND label, and names the button for screen readers', async () => {
      const { fixture } = await setup('');
      const send = (fixture.nativeElement as HTMLElement).querySelector('.btn-send') as HTMLButtonElement;
      expect(send.textContent?.trim()).toBe('');
      expect(send.querySelector('lucide-icon[name="arrow-up"], .send-icon')).toBeTruthy();
      expect(send.getAttribute('aria-label')).toBe('Send message');
    });

    it('is one textarea from the start, so long text can wrap', async () => {
      const { fixture, field } = await setup('');
      expect((fixture.nativeElement as HTMLElement).querySelector('input.form-control')).toBeNull();
      expect(field.classList.contains('composer-field--expanded')).toBe(false);
    });

    it('sends on Enter while collapsed', async () => {
      const { field, sent, press } = await setup('hello');
      expect(press({}).defaultPrevented).toBe(true);
      expect(sent).toEqual(['hello']);
      expect(field.classList.contains('composer-field--expanded')).toBe(false);
    });

    it.each([{ ctrlKey: true }, { shiftKey: true }])(
      'expands on %o without adding a line, sending, or moving the caret',
      async (modifier) => {
        const { fixture, field, sent, press } = await setup('some draft text');
        field.setSelectionRange(4, 4);

        expect(press(modifier).defaultPrevented).toBe(true);

        expect(sent).toEqual([]);
        expect(fixture.componentInstance.composerDraft()).toBe('some draft text');
        expect(field.value).toBe('some draft text');
        expect(field.selectionStart).toBe(4);
        expect(field.classList.contains('composer-field--expanded')).toBe(true);
        expect((fixture.nativeElement as HTMLElement).querySelector('textarea.form-control')).toBe(field);
      },
    );

    it('expands an empty entry without putting a line in it', async () => {
      const { fixture, field, press } = await setup('');
      press({ ctrlKey: true });
      expect(fixture.componentInstance.composerDraft()).toBe('');
      expect(field.classList.contains('composer-field--expanded')).toBe(true);
    });

    it.each([{ ctrlKey: true }, { shiftKey: true }])('once expanded, sends on %o and collapses', async (modifier) => {
      const { field, sent, press } = await setup('hello');
      press({ ctrlKey: true });
      press(modifier);
      expect(sent).toEqual(['hello']);
      expect(field.classList.contains('composer-field--expanded')).toBe(false);
    });

    it('once expanded, leaves plain Enter to the textarea for a real new line', async () => {
      const { sent, press } = await setup('hello');
      press({ ctrlKey: true });
      expect(press({}).defaultPrevented).toBe(false);
      expect(sent).toEqual([]);
    });

    it('expands by itself for a draft that already has lines', async () => {
      const { field } = await setup('two\nlines');
      expect(field.classList.contains('composer-field--expanded')).toBe(true);
    });

    it('collapses from the prompt button, joining any lines', async () => {
      const { fixture, field } = await setup('two\nlines');
      ((fixture.nativeElement as HTMLElement).querySelector('.composer-prompt') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(fixture.componentInstance.composerDraft()).toBe('two lines');
      expect(field.classList.contains('composer-field--expanded')).toBe(false);
    });
  });

  it('says how to get out of a full context on Send and in both composer fields', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.componentRef.setInput('contextBlocked', true);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const hint = 'Context full: turn on context compaction in Settings or start a new conversation';
    const send = root.querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe(hint);
    expect((root.querySelector('textarea.form-control') as HTMLTextAreaElement).placeholder).toBe(hint);

    fixture.componentInstance.composerDraft.set('two\nlines');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect((root.querySelector('textarea.form-control') as HTMLTextAreaElement).placeholder).toBe(hint);
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

  it('sends while a reply streams (an interrupt), keeping Stop, and waits while the old reply drains', async () => {
    const fixture = TestBed.createComponent(MessageBox);
    const sent = vi.fn();
    fixture.componentInstance.messageSent.subscribe(sent);
    fixture.componentRef.setInput('appConfig', openaiConfig());
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // Nothing typed: only Stop.
    expect(host.querySelector('.btn-send')).toBeNull();
    expect(host.querySelector('.btn-abort')).toBeTruthy();

    fixture.componentInstance.composerDraft.set('actually, use the other file');
    fixture.detectChanges();
    const send = host.querySelector('.btn-send--interrupt') as HTMLButtonElement;
    expect(send).toBeTruthy();
    expect(send.title).toContain('interrupts');
    expect(host.querySelector('.btn-abort')).toBeTruthy();

    drainingIds.set(new Set(['conv-1']));
    fixture.detectChanges();
    expect(send.disabled).toBe(true);
    fixture.componentInstance.send();
    expect(sent).not.toHaveBeenCalled();

    drainingIds.set(new Set());
    fixture.detectChanges();
    send.click();
    expect(sent).toHaveBeenCalledWith('actually, use the other file');
  });
});
