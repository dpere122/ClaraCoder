import { Component, computed, DestroyRef, effect, ElementRef, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  COMPOSER_RUN_MODES,
  COMPOSER_RUN_MODE_LABELS,
  DEFAULT_COMPOSER_RUN_MODE,
  findManagedLocalLlamaLocation,
  formatTokensPerSecond,
  llmComposerEffortOptions,
  llmComposerEffortValue,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  resolveActiveLlmConnection,
  turnTokensPerSecond,
  type AppConfig,
  type ChatTemplateReasoningCaps,
  type ComposerRunMode,
  type GemmaThinkingMode,
  type LlamaServerLifecycleEvent,
  type LlamaServerProcessExitEvent,
  type LlmReasoningEffort,
  type LlmReasoningSettingChange,
  type LlmSourcePingResult,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { filter, merge } from 'rxjs';

import { AnthropicService } from '../../../core/anthropic.service';
import { claudeModelOptions } from '../../../core/claude-models';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { ContextCapacityComponent } from '../../status/context-capacity/context-capacity';
import { ConversationSessionService } from '../../shell/conversation-session.service';
import { GenerationRateService } from '../chat-box/generation-rate';
import { ChatContextBar } from '../chat-context-bar/chat-context-bar';
import { type ChatContextDroppedPath } from '../chat-context-bar/chat-context-drop';
import { type ChatContextFile } from '../chat-context-bar/chat-context-file';

const CONTEXT_FULL_HINT = 'Context full: turn on context compaction in Settings or start a new conversation';
/** How often the selected source is re-checked, so Send follows a server going down or coming back. */
const SOURCE_POLL_MS = 15_000;
/** Missed ``/health`` probes in a row before a running llama-server counts as hung, not just busy. */
const LLAMA_HUNG_AFTER_MISSES = 2;

@Component({
  selector: 'app-message-box',
  imports: [FormsModule, LucideAngularModule, ContextCapacityComponent, ChatContextBar, PillSelectComponent],
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
  protected readonly composerModeOptions = COMPOSER_RUN_MODES.map((mode) => ({
    id: mode,
    label: COMPOSER_RUN_MODE_LABELS[mode],
  }));

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
  /** Files attached to the next turn, rendered as chips at the top of the composer box. */
  readonly contextFiles = input<readonly ChatContextFile[]>([]);
  /** Workspace root for resolving image thumbnails in the context chips. */
  readonly workspaceRoot = input('');
  /** User removed an attached context file. */
  readonly removeContextFile = output<ChatContextFile>();
  /** User toggled pinning on an editor-selection context file. */
  readonly togglePinContextFile = output<ChatContextFile>();
  /** Files/folders dropped onto the context section. */
  readonly contextPathsDropped = output<ChatContextDroppedPath[]>();
  /** When true (Agent/Plan), tool calls and edits run automatically. Hidden in Ask mode. */
  readonly autoApplyMode = model(false);
  /** When true, this conversation may run elevated ``run_command``. */
  readonly adminElevationGranted = model(false);
  /** True while the Admin-chip confirmation HITL is pending. */
  readonly adminElevationPending = input(false);
  /** User clicked Admin while it was off; parent opens the grant HITL. */
  readonly adminGrantRequested = output<void>();
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
  /** The managed llama-server process is up but stopped answering its health check. */
  private readonly llamaUnresponsive = signal(false);
  private llamaStatusProbeId = 0;
  /** Status probes in a row that got no ``/health`` answer outside a turn. */
  private llamaHealthMisses = 0;
  /** Last answer from the selected non-managed source; null until the first one arrives. */
  private readonly sourcePing = signal<LlmSourcePingResult | null>(null);
  private sourcePingId = 0;
  /** Identifies what is being pinged: a new endpoint must not inherit the old one's answer. */
  private readonly pingedEndpoint = computed(() => {
    const conn = this.activeConnection();
    return conn && !this.managedLocalLlama() ? `${conn.id}\n${conn.baseUrl}` : '';
  });
  /**
   * Send is allowed once the selected source has proven it can take a request: a managed llama-server
   * is running and healthy, any other source answered its last ping.
   */
  protected readonly sourceActive = computed(() => {
    if (!this.activeConnection()) {
      return false;
    }
    if (this.managedLocalLlama()) {
      return this.llamaLive();
    }
    return this.sourcePing()?.ok === true;
  });
  /** Why the source can't take a message; empty when it can, or while its first ping is out. */
  private readonly sourceBlockedReason = computed(() => {
    if (!this.activeConnection()) {
      return 'No LLM source selected';
    }
    if (this.managedLocalLlama()) {
      if (this.llamaLive()) {
        return '';
      }
      return this.llamaUnresponsive() ? "The local llama-server isn't responding" : 'Start the local llama-server to send';
    }
    const ping = this.sourcePing();
    return ping && !ping.ok ? ping.error : '';
  });
  /** Composer send is blocked by a full context window or an inactive LLM source. */
  protected readonly sendDisabled = computed(() => this.contextBlocked() || !this.sourceActive());
  /** Something to send: while a reply streams, Send (which interrupts it) only shows then. */
  protected readonly hasDraft = computed(() => this.composerDraft().trim().length > 0 || this.attachmentCount() > 0);
  /** Composer field hint: why nothing can be sent right now. */
  protected readonly composerPlaceholder = computed(() =>
    this.contextBlocked() ? CONTEXT_FULL_HINT : this.sourceBlockedReason(),
  );
  /** Tooltip for the Send button when it is disabled. */
  protected readonly sendTitle = computed(() => {
    const blocked = this.composerPlaceholder();
    if (blocked) {
      return blocked;
    }
    return this.sourceActive() ? 'Send message' : 'Checking the connection…';
  });
  private readonly liveCaps = computed(() => {
    const id = this.activeConnection()?.id;
    return id ? this.capsByModel()[id] : undefined;
  });
  protected readonly thinkingVisible = computed(() =>
    llmThinkingControlVisible(this.activeConnection()?.optimizationPreset, this.liveCaps()),
  );
  /** Only the efforts the model's template advertised; no preset guesses or Default/on/off. */
  private readonly scannedEffortOptions = computed(() => llmComposerEffortOptions(this.liveCaps()));
  /**
   * Scanned efforts; for an unscanned source, Settings' list while an effort is saved (it is still
   * sent, so it stays visible and can be set back to Default).
   */
  protected readonly reasoningEffortOptions = computed(() => {
    const scanned = this.scannedEffortOptions();
    if (scanned.length || !this.activeConnection()?.reasoningEffort) {
      return scanned;
    }
    return llmEffortSelectOptionsFromCaps(this.liveCaps(), this.activeConnection()?.optimizationPreset);
  });
  protected readonly effortVisible = computed(() => this.reasoningEffortOptions().length > 0);
  protected readonly showReasoningCluster = computed(() => this.thinkingVisible() || this.effortVisible());
  private readonly anthropic = inject(AnthropicService);
  /** Claude is the active source: the composer offers its model list. */
  protected readonly claudeActive = computed(() => this.activeConnection()?.provider === 'anthropic');
  protected readonly claudeModelId = computed(() => (this.claudeActive() ? (this.activeConnection()?.model ?? '') : ''));
  protected readonly claudeModelOptions = computed(() =>
    this.claudeActive() ? claudeModelOptions(this.anthropic.models(), this.claudeModelId()) : [],
  );
  protected readonly claudeModelBusy = signal(false);

  protected readonly thinkingMode = computed(() => this.activeConnection()?.thinkingMode || 'default');
  /** Brain toggle: anything except explicit ``off`` counts as reasoning enabled. */
  protected readonly reasoningEnabled = computed(() => this.thinkingMode() !== 'off');
  protected readonly reasoningEffort = computed(() => {
    const saved = this.activeConnection()?.reasoningEffort || '';
    const scanned = this.scannedEffortOptions();
    return scanned.length ? llmComposerEffortValue(scanned, saved) : saved;
  });
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly usedPercentage = input(0);
  private readonly session = inject(ConversationSessionService);
  private readonly generationRate = inject(GenerationRateService);
  /** A reply is streaming in any conversation, which all share the selected source. */
  private readonly turnInFlight = computed(() => this.loading() || this.session.pendingIds().size > 0);
  /** An interrupt is still stopping the previous reply; the next send waits for it. */
  protected readonly draining = computed(() => {
    const id = this.session.activeConversationId();
    return id != null && this.session.drainingConversationIds().has(id);
  });
  /**
   * Tokens/sec beside the context meter: the live rate while a reply streams, otherwise the
   * latest saved turn's rate (dimmed). Null before anything was measured.
   */
  protected readonly tokenRate = computed(() => {
    if (this.loading()) {
      const id = this.session.activeConversationId();
      const live = id ? this.generationRate.live()[id] : undefined;
      return live ? { ...live, live: true } : null;
    }
    const msgs = this.session.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.generation) {
        const tokensPerSecond = turnTokensPerSecond(m.generation);
        return tokensPerSecond > 0
          ? { tokensPerSecond, estimated: !!m.generation.estimated, live: false }
          : null;
      }
    }
    return null;
  });
  protected readonly tokenRateLabel = computed(() => {
    const rate = this.tokenRate();
    return rate ? `${rate.estimated ? '~' : ''}${formatTokensPerSecond(rate.tokensPerSecond)}` : '';
  });
  protected readonly tokenRateTitle = computed(() => {
    const rate = this.tokenRate();
    if (!rate) return '';
    const what = rate.live ? 'Output speed of the reply in progress' : 'Output speed of the last reply';
    return rate.estimated ? `${what} (estimated from streamed text)` : what;
  });
  /** Trimmed composer text (may be empty when attachments are present). */
  readonly messageSent = output<string>();
  /** User clicked Stop while {@link loading} is true. */
  readonly abortRequested = output<void>();
  /** Draft text bound to the composer input (parent may restore a prior user prompt here). */
  readonly composerDraft = model('');
  /**
   * Session-scoped multiline toggle (prompt button): Enter adds a line and the entry holds a taller
   * minimum height. Long text wraps with or without it; this only changes what Enter does and the height.
   */
  protected readonly multilineMode = signal(false);
  /** `#messageInput` in template; used to restore focus after send. */
  private readonly messageInputEl = viewChild<ElementRef<HTMLTextAreaElement>>('messageInput');

  constructor() {
    effect(() => {
      const id = this.activeConnection()?.id;
      // The model is read too: the Claude source keeps its connection id when its model changes.
      void this.activeConnection()?.model;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });

    effect(() => {
      if (this.claudeActive()) {
        void this.anthropic.ensureLoaded();
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
      this.pingedEndpoint();
      this.sourcePing.set(null);
    });

    // Re-check on any config change, and when a turn starts or ends: a failed turn is often the
    // first sign that the source went away.
    effect(() => {
      this.appConfig();
      this.managedLocalLlama();
      this.turnInFlight();
      untracked(() => this.probeSource());
    });

    const pollSource = (): void => {
      // A busy server can miss a ping and a running turn already shows the source works, so only a
      // source that is locked keeps being checked mid-turn: it must be able to unlock.
      if (!document.hidden && (!this.turnInFlight() || !this.sourceActive())) {
        this.probeSource();
      }
    };
    const pollTimer = window.setInterval(pollSource, SOURCE_POLL_MS);
    window.addEventListener('focus', pollSource);
    this.destroyRef.onDestroy(() => {
      window.clearInterval(pollTimer);
      window.removeEventListener('focus', pollSource);
    });

    // A saved effort the model does not offer (Default, on/off, another model's) would still be
    // sent; persist the effort the dropdown shows instead.
    effect(() => {
      const shown = this.reasoningEffort();
      const saved = this.activeConnection()?.reasoningEffort || '';
      if (shown && shown !== saved) {
        this.reasoningEffortChange.emit({ field: 'reasoningEffort', value: shown as LlmReasoningEffort });
      }
    });

    effect(() => {
      if (this.composerDraft().includes('\n') && !this.multilineMode()) {
        this.multilineMode.set(true);
      }
    });
  }

  /** Forwards the voice button click to {@link voiceToggle}. */
  onVoiceButtonClick(): void {
    this.voiceToggle.emit();
  }

  /**
   * Admin chip: revoke immediately when on; request a grant HITL when off.
   * Does not turn the chip on until the parent confirms the card.
   */
  onAdminChipClick(): void {
    if (this.adminElevationGranted()) {
      this.adminElevationGranted.set(false);
      return;
    }
    if (this.adminElevationPending()) {
      return;
    }
    this.adminGrantRequested.emit();
  }

  /** Brain button: toggle thinking on/off; on unlocks the effort dropdown. */
  onReasoningToggle(): void {
    const next: GemmaThinkingMode = this.reasoningEnabled() ? 'off' : 'on';
    this.reasoningEffortChange.emit({ field: 'thinkingMode', value: next });
  }

  /** Claude model dropdown: main saves the pick and resyncs the backend, then broadcasts the config. */
  async onClaudeModelChange(modelId: string): Promise<void> {
    if (!modelId || modelId === this.claudeModelId() || this.claudeModelBusy()) {
      return;
    }
    this.claudeModelBusy.set(true);
    try {
      await this.anthropic.setModel(modelId);
    } finally {
      this.claudeModelBusy.set(false);
    }
  }

  /** Forwards the composer Reasoning dropdown to {@link reasoningEffortChange}. */
  onReasoningEffortChange(value: string): void {
    const allowed = new Set(this.reasoningEffortOptions().map((o) => o.value));
    if (allowed.has(value)) {
      this.reasoningEffortChange.emit({ field: 'reasoningEffort', value: value as LlmReasoningEffort });
    }
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
      const text = this.composerDraft();
      if (text.includes('\n')) {
        this.composerDraft.set(text.replace(/\n+/g, ' ').trim());
      }
    }
    this.multilineMode.update((on) => !on);
    this.focusInput();
  }

  /**
   * Keyboard routing. Single-line: Enter sends; Ctrl/Shift+Enter expands the entry without touching
   * the text or the caret. Multiline: Enter adds a line; Ctrl/Shift+Enter sends; Escape blurs.
   *
   * @param event - Native keydown from the textarea.
   */
  onComposerKeydown(event: KeyboardEvent): void {
    const multiline = this.multilineMode();
    if (event.key === 'Escape' && multiline) {
      event.preventDefault();
      this.messageInputEl()?.nativeElement.blur();
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    const modified = event.ctrlKey || event.shiftKey;
    if (multiline && !modified) {
      return;
    }
    event.preventDefault();
    // Holding the chord must not run on from expanding the entry into sending the draft.
    if (modified && event.repeat) {
      return;
    }
    if (!multiline && modified) {
      this.multilineMode.set(true);
      return;
    }
    this.send();
  }

  /**
   * Validates draft text (or attachments), emits {@link messageSent}, and clears input.
   * Resets multiline mode so the next draft starts in single-line entry. While {@link loading}
   * the message interrupts the reply in progress (the parent ends that turn first).
   * No-op while {@link contextBlocked}, an interrupt is still stopping the previous reply, or
   * the current LLM source is inactive.
   */
  send(): void {
    if (this.sendDisabled() || this.draining()) return;
    const msg = this.composerDraft().trim();
    if (!msg && this.attachmentCount() === 0) return;
    this.messageSent.emit(msg);
    this.composerDraft.set('');
    this.multilineMode.set(false);
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

  /**
   * Mirrors llama Start/Stop into Send availability. If a turn is in flight when the
   * chat server dies, emit abort so the parent can drop the hung Stop button.
   */
  private applyLlamaLifecycleEvent(e: LlamaServerLifecycleEvent | LlamaServerProcessExitEvent): void {
    if (!('phase' in e) && e.stream !== 'chat') {
      return;
    }
    // A status probe still out predates this event, so its answer must not overwrite it.
    this.llamaStatusProbeId++;
    this.llamaHealthMisses = 0;
    this.llamaUnresponsive.set(false);
    if ('phase' in e) {
      this.llamaLive.set(e.phase === 'running');
      if (e.phase === 'stopped' && this.loading()) {
        this.abort();
      }
      return;
    }
    this.llamaLive.set(false);
    if (this.loading()) {
      this.abort();
    }
  }

  /** Checks whichever way the selected source can be reached. */
  private probeSource(): void {
    const cfg = this.appConfig();
    const llama = this.managedLocalLlama();
    if (cfg && llama) {
      void this.probeLlamaLive(cfg, llama.model.id);
      return;
    }
    this.llamaLive.set(false);
    this.llamaUnresponsive.set(false);
    if (cfg && this.activeConnection()) {
      void this.pingSource(cfg, cfg.activeLlmModelId);
    }
  }

  /** Probe whether the managed local llama-server is running and answering. */
  private async probeLlamaLive(cfg: AppConfig, modelId: string): Promise<void> {
    const req = ++this.llamaStatusProbeId;
    try {
      const res = await this.electron.llamaServerStatus({ modelId, config: cfg });
      if (req !== this.llamaStatusProbeId) {
        return;
      }
      // A server stalled on a long prompt can miss one probe, and during a turn it is expected to.
      const missed = !!(res.ok && res.running && res.chat.health === 'error') && !this.turnInFlight();
      this.llamaHealthMisses = missed ? this.llamaHealthMisses + 1 : 0;
      const hung = this.llamaHealthMisses >= LLAMA_HUNG_AFTER_MISSES;
      this.llamaUnresponsive.set(hung);
      this.llamaLive.set(!!(res.ok && res.running) && !hung);
    } catch {
      if (req !== this.llamaStatusProbeId) {
        return;
      }
      this.llamaUnresponsive.set(false);
      this.llamaLive.set(false);
    }
  }

  /** Ping the selected non-managed source; a stale answer from a previous source is dropped. */
  private async pingSource(cfg: AppConfig, modelId: string): Promise<void> {
    const req = ++this.sourcePingId;
    let result: LlmSourcePingResult;
    try {
      result = await this.electron.llmSourcePing({ modelId, config: cfg });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (req !== this.sourcePingId) {
      return;
    }
    // A busy server can miss a ping mid-turn; the check when the turn ends has the last word.
    if (!result.ok && this.turnInFlight() && this.sourcePing()?.ok) {
      return;
    }
    this.sourcePing.set(result);
  }
}
