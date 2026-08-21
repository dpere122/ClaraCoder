import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, Injector, input, model, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  COMPOSER_RUN_MODES,
  COMPOSER_RUN_MODE_LABELS,
  DEFAULT_COMPOSER_RUN_MODE,
  findManagedLocalLlamaLocation,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  resolveActiveLlmConnection,
  type AppConfig,
  type ChatTemplateReasoningCaps,
  type ComposerRunMode,
  type GemmaThinkingMode,
  type LlamaServerLifecycleEvent,
  type LlamaServerProcessExitEvent,
  type LlmReasoningEffort,
  type LlmReasoningSettingChange,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { filter, merge } from 'rxjs';

import { ElectronService } from '../../../core/electron.service';
import { ContextCapacityComponent } from '../../status/context-capacity/context-capacity';

type ComposerField = HTMLInputElement | HTMLTextAreaElement;

@Component({
  selector: 'app-message-box',
  imports: [FormsModule, LucideAngularModule, ContextCapacityComponent],
  templateUrl: './message-box.html',
  styleUrl: './message-box.css'
})
/**
 * Bottom composer: text input, reasoning effort, run-mode selector, voice toggle, and send/abort controls.
 *
 * Parent owns streaming state and talk capture; this component emits user actions upward
 * via {@link messageSent}, {@link abortRequested}, {@link voiceToggle}, and {@link reasoningEffortChange}.
 */
export class MessageBox {
  /** Two-way run mode for the next turn (Agent, Ask, or Plan). */
  readonly composerMode = model<ComposerRunMode>(DEFAULT_COMPOSER_RUN_MODE);
  /** Select options bound in the template. */
  readonly composerModes = COMPOSER_RUN_MODES;
  /** Human-readable labels keyed by {@link ComposerRunMode}. */
  readonly composerModeLabels = COMPOSER_RUN_MODE_LABELS;

  /** Mic + spoken replies active (parent syncs `talkEnabled` && `speechEnabled`). */
  readonly voiceActive = input(false);
  /** User toggled the voice button; parent flips talk/speech state. */
  readonly voiceToggle = output<void>();
  /** Short live caption from talk capture (shown above the input row). */
  readonly talkStatus = input('');
  /** Secondary talk-mode status line when {@link talkStatus} is empty. */
  readonly talkDetail = input('');
  /** Assistant reply in flight — swaps Send for Stop. */
  readonly loading = input(false);
  /** Context window full — input disabled and placeholder explains why. */
  readonly contextBlocked = input(false);
  /** Staged reference-bar file count; allows send with empty text when > 0. */
  readonly attachmentCount = input(0);
  /** When true (Agent/Plan), tool calls and edits run automatically. Hidden in Ask mode. */
  readonly autoApplyMode = model(false);
  /** Active app config — drives model/embeddings status beside the context meter. */
  readonly appConfig = input<AppConfig | null>(null);
  /** User changed Reasoning/Thinking; parent persists onto the active model profile. */
  readonly reasoningEffortChange = output<LlmReasoningSettingChange>();
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly capsByModel = toSignal(this.electron.chatTemplateReasoning$, {
    initialValue: {} as Readonly<Record<string, ChatTemplateReasoningCaps>>,
  });
  /** Active chat connection, or null when config has no resolvable model. */
  protected readonly activeConnection = computed(() => {
    const cfg = this.appConfig();
    return cfg ? resolveActiveLlmConnection(cfg) : null;
  });
  /** Managed local llama.cpp source (Start/Stop eligible); null for URL/LM Studio/OpenAI. */
  private readonly managedLocalLlama = computed(() => {
    const cfg = this.appConfig();
    return cfg ? findManagedLocalLlamaLocation(cfg) : null;
  });
  /** True while the managed local llama-server is accepting traffic. */
  private readonly llamaLive = signal(false);
  private llamaStatusProbeId = 0;
  /**
   * Send is allowed when a chat source is selected and, for local llama.cpp, the server is running.
   * Remote / LM Studio / OpenAI sources are treated as active once a connection is resolvable.
   */
  protected readonly sourceActive = computed(() => {
    if (!this.activeConnection()) {
      return false;
    }
    if (this.managedLocalLlama()) {
      return this.llamaLive();
    }
    return true;
  });
  /** Composer send is blocked by a full context window or an inactive LLM source. */
  protected readonly sendDisabled = computed(() => this.contextBlocked() || !this.sourceActive());
  /** Tooltip for the Send button when it is disabled. */
  protected readonly sendTitle = computed(() => {
    if (this.contextBlocked()) {
      return 'Context full — start a new conversation to continue';
    }
    if (!this.activeConnection()) {
      return 'No LLM source selected';
    }
    if (this.managedLocalLlama() && !this.llamaLive()) {
      return 'Start the local llama-server to send';
    }
    return 'Send message';
  });
  private readonly liveCaps = computed(() => {
    const id = this.activeConnection()?.id;
    return id ? this.capsByModel()[id] : undefined;
  });
  protected readonly thinkingVisible = computed(() =>
    llmThinkingControlVisible(this.activeConnection()?.optimizationPreset, this.liveCaps()),
  );
  protected readonly effortVisible = computed(() =>
    llmEffortControlVisible(this.activeConnection()?.optimizationPreset, this.liveCaps()),
  );
  protected readonly showReasoningCluster = computed(() => this.thinkingVisible() || this.effortVisible());
  protected readonly reasoningEffortOptions = computed(() =>
    llmEffortSelectOptionsFromCaps(this.liveCaps(), this.activeConnection()?.optimizationPreset),
  );
  protected readonly thinkingMode = computed(() => this.activeConnection()?.thinkingMode || 'default');
  /** Brain toggle: anything except explicit ``off`` counts as reasoning enabled. */
  protected readonly reasoningEnabled = computed(() => this.thinkingMode() !== 'off');
  protected readonly reasoningEffort = computed(() => this.activeConnection()?.reasoningEffort || '');
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly usedPercentage = input(0);
  /** Trimmed composer text (may be empty when attachments are present). */
  readonly messageSent = output<string>();
  /** User clicked Stop while {@link loading} is true. */
  readonly abortRequested = output<void>();
  /** Draft text bound to the composer input. */
  protected readonly userInput = signal('');
  /** Session-scoped multiline composer toggle (prompt button). */
  protected readonly multilineMode = signal(false);
  /** `#messageInput` in template; used to restore focus after send. */
  private readonly messageInputEl = viewChild<ElementRef<ComposerField>>('messageInput');
  private readonly injector = inject(Injector);

  constructor() {
    effect(() => {
      const id = this.activeConnection()?.id;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });

    merge(this.electron.llamaServerLifecycle$, this.electron.llamaServerProcessExit$)
      .pipe(
        filter((e) => {
          const id = this.managedLocalLlama()?.model.id;
          return !!id && e.modelId === id;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((e) => {
        this.applyLlamaLifecycleEvent(e);
      });

    effect(() => {
      const cfg = this.appConfig();
      const loc = this.managedLocalLlama();
      if (!cfg || !loc) {
        this.llamaLive.set(false);
        return;
      }
      void this.probeLlamaLive(cfg, loc.model.id);
    });
  }

  /** Forwards the voice button click to {@link voiceToggle}. */
  onVoiceButtonClick(): void {
    this.voiceToggle.emit();
  }

  /** Brain button: toggle thinking on/off; on unlocks the effort dropdown. */
  onReasoningToggle(): void {
    const next: GemmaThinkingMode = this.reasoningEnabled() ? 'off' : 'on';
    this.reasoningEffortChange.emit({ field: 'thinkingMode', value: next });
  }

  /** Forwards the composer Reasoning dropdown to {@link reasoningEffortChange}. */
  onReasoningEffortChange(value: string): void {
    const allowed = new Set(this.reasoningEffortOptions().map((o) => o.value));
    const effort = (allowed.has(value) ? value : '') as LlmReasoningEffort;
    this.reasoningEffortChange.emit({ field: 'reasoningEffort', value: effort });
  }

  /**
   * Keeps focus on the composer field when clicking the prompt toggle.
   *
   * @param event - Native mousedown; default prevented so the button does not retain focus.
   */
  onPromptMouseDown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Toggles multiline mode. Collapses embedded newlines when returning to single-line.
   *
   * @param event - Click event; propagation stopped so composer mousedown does not refocus.
   */
  toggleMultilineMode(event: MouseEvent): void {
    event.stopPropagation();
    if (this.multilineMode()) {
      this.disableMultilineMode();
    } else {
      this.enableMultilineMode();
    }
  }

  /**
   * Single-line keyboard routing: Enter sends; Shift+Enter enables multiline.
   *
   * @param event - Native keydown from the input.
   */
  onSingleLineKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      this.enableMultilineMode();
      return;
    }
    this.send();
  }

  /** Enables multiline mode and prepares the draft for a new line. */
  private enableMultilineMode(): void {
    if (this.multilineMode()) {
      return;
    }
    const current = this.userInput();
    const wasEmpty = current.length === 0;
    if (wasEmpty) {
      this.userInput.set('\n');
    } else if (!current.endsWith('\n')) {
      this.userInput.set(`${current}\n`);
    }
    this.multilineMode.set(true);
    this.focusComposerAfterRender(wasEmpty ? 0 : undefined);
  }

  /** Disables multiline mode and collapses embedded newlines. */
  private disableMultilineMode(): void {
    if (!this.multilineMode()) {
      return;
    }
    const text = this.userInput();
    if (text.includes('\n')) {
      this.userInput.set(text.replace(/\n+/g, ' ').trim());
    }
    this.multilineMode.set(false);
    this.focusComposerAfterRender();
  }

  /**
   * Multiline keyboard routing: Escape blurs; Enter inserts a newline; Shift+Enter sends.
   *
   * @param event - Native keydown from the textarea.
   */
  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.messageInputEl()?.nativeElement.blur();
      return;
    }
    if (event.key !== 'Enter' || !event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.send();
  }

  /** Re-syncs textarea height after content or wrap changes. */
  onTextareaInput(): void {
    this.adjustTextareaHeight();
  }

  /**
   * Validates draft text (or attachments), emits {@link messageSent}, and clears input.
   * Resets multiline mode so the next draft starts in single-line entry.
   * No-op while {@link loading}, {@link contextBlocked}, or the current LLM source is inactive.
   */
  send(): void {
    if (this.loading() || this.sendDisabled()) return;
    const msg = this.userInput().trim();
    if (!msg && this.attachmentCount() === 0) return;
    this.messageSent.emit(msg);
    this.userInput.set('');
    if (this.multilineMode()) {
      this.multilineMode.set(false);
      this.focusComposerAfterRender();
      return;
    }
    this.focusInput();
  }

  /** Emits {@link abortRequested} for the in-flight generation. */
  abort(): void {
    this.abortRequested.emit();
  }

  /**
   * Left-click anywhere on the composer chrome focuses the text field.
   * Defers via microtask so mousedown on the input itself is not fighting focus.
   *
   * @param event - Native mousedown; only primary button is handled.
   */
  onComposerMouseDown(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('.composer-prompt')) {
      return;
    }
    queueMicrotask(() => this.focusInput());
  }

  /**
   * Returns keyboard focus to the composer after send or chrome click.
   * Blurs a stale terminal/xterm focus target first so key events route here.
   */
  private focusInput(): void {
    const input = this.messageInputEl()?.nativeElement;
    if (!input || input === document.activeElement) {
      return;
    }
    // Blur stale terminal/xterm focus first so keyboard events route back to composer.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== input) {
      active.blur();
    }
    input.focus({ preventScroll: true });
  }

  /** Grows the multiline textarea to fit content up to the CSS max-height. */
  private adjustTextareaHeight(): void {
    const el = this.messageInputEl()?.nativeElement;
    if (!(el instanceof HTMLTextAreaElement)) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  /**
   * Focuses the composer after Angular swaps input/textarea on toggle.
   * Height is synced first; focus is deferred so layout can expand cleanly.
   *
   * @param cursor - Optional caret position; defaults to end of current value.
   */
  private focusComposerAfterRender(cursor?: number): void {
    afterNextRender(() => {
      this.syncComposerFieldLayout();

      requestAnimationFrame(() => {
        this.syncComposerFieldLayout();

        window.setTimeout(() => {
          this.focusComposerField(cursor);
        }, 0);
      });
    }, { injector: this.injector });
  }

  /** Syncs multiline textarea height without moving focus. */
  private syncComposerFieldLayout(): void {
    if (this.multilineMode()) {
      this.adjustTextareaHeight();
    }
  }

  /**
   * Moves focus into the composer and restores the caret.
   *
   * @param cursor - Optional caret position; defaults to end of current value.
   */
  private focusComposerField(cursor?: number): void {
    const el = this.messageInputEl()?.nativeElement;
    if (!el) {
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== el) {
      active.blur();
    }
    el.focus({ preventScroll: true });
    const caret = cursor ?? el.value.length;
    el.setSelectionRange(caret, caret);
    this.syncComposerFieldLayout();
  }

  /**
   * Mirrors llama Start/Stop into Send availability. If a turn is in flight when the
   * chat server dies, emit abort so the parent can drop the hung Stop button.
   */
  private applyLlamaLifecycleEvent(e: LlamaServerLifecycleEvent | LlamaServerProcessExitEvent): void {
    if ('phase' in e) {
      this.llamaLive.set(e.phase === 'running');
      if (e.phase === 'stopped' && this.loading()) {
        this.abort();
      }
      return;
    }
    if (e.stream !== 'chat') {
      return;
    }
    this.llamaLive.set(false);
    if (this.loading()) {
      this.abort();
    }
  }

  /** Probe whether the managed local llama-server is currently running. */
  private async probeLlamaLive(cfg: AppConfig, modelId: string): Promise<void> {
    const req = ++this.llamaStatusProbeId;
    try {
      const res = await this.electron.llamaServerStatus({ modelId, config: cfg });
      if (req !== this.llamaStatusProbeId) {
        return;
      }
      this.llamaLive.set(!!(res.ok && res.running));
    } catch {
      if (req !== this.llamaStatusProbeId) {
        return;
      }
      this.llamaLive.set(false);
    }
  }
}
