import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type {
  AppConfig,
  ComposerRunMode,
  HitlTrailArtifact,
  LlmReasoningSettingChange,
  PlannerProgress,
  StreamPart,
} from '@shared/index';
import { DEFAULT_COMPOSER_RUN_MODE, normalizeChatContainerSize, normalizeChatThinkingDisplay } from '@shared/index';
import type { ThemeProposalFinishedEvent } from '@shared/index';
import {
  ChatBox,
  hitlDockArtifactsBesidePlan,
  livePlanDockContext,
  pendingHitlArtifactsForDock,
  type ChatMessage,
} from '../chat-box/chat-box';
import { PlannerChecklistComponent } from '../chat-box/planner-checklist/planner-checklist';
import { handleChatContextDragOver, handleChatContextDrop, type ChatContextDroppedPath } from '../chat-context-bar/chat-context-drop';
import { type ChatContextFile } from '../chat-context-bar/chat-context-file';
import { HitlComposerDockComponent } from '../hitl-composer-dock/hitl-composer-dock';
import { MessageBox } from '../message-box/message-box';
import { SubagentDockComponent } from '../subagent-dock/subagent-dock';
import { TalkMode } from '../../speech/talk-mode/talk-mode';
import { ConversationSessionService } from '../../shell/conversation-session.service';
import { LucideAngularModule } from 'lucide-angular';
import type { AcceptCommandFinishedEvent } from '@shared/index';
import type { TurnDiffOpenRequest } from '../chat-box/turn-edits-footer/turn-edits-footer';
export type ChatLayoutMode = 'sidebar' | 'expanded';

/** Chat transcript, composer, and status bar — shared by sidebar hub and expanded main overlay. */
@Component({
  selector: 'app-chat-active-stack',
  imports: [
    ChatBox,
    HitlComposerDockComponent,
    LucideAngularModule,
    MessageBox,
    PlannerChecklistComponent,
    SubagentDockComponent,
    TalkMode,
  ],
  templateUrl: './chat-active-stack.html',
  styleUrl: './chat-active-stack.css',
  host: {
    '[class.chat-active-stack--layout-expanded]': 'layout() === "expanded"',
    '[class.chat-active-stack--container-narrow]':
      'layout() === "expanded" && resolvedContainerSize() === "narrow"',
    '[class.chat-active-stack--container-standard]':
      'layout() === "expanded" && resolvedContainerSize() === "standard"',
    '[class.chat-active-stack--container-full-width]':
      'layout() === "expanded" && resolvedContainerSize() === "full-width"',
    '[class.chat-active-stack--ready]': 'emptyStateReady()',
    '[class.chat-active-stack--empty]': 'showBrandEtch()',
    // OPEN_CONVERSATION_DOM_EVENT, bubbling up from a sub-agent pill in the transcript.
    '(clara-open-conversation)': 'onOpenConversationRequested($event)',
  },
})
export class ChatActiveStackComponent implements OnDestroy {
  /** Sidebar hub vs main-panel expanded overlay — reserved for layout-specific chrome. */
  readonly layout = input<ChatLayoutMode>('expanded');

  readonly messages = input<ChatMessage[]>([]);
  readonly conversationId = input<string | null>(null);
  readonly loading = input(false);
  readonly processingToolsActive = input(false);
  readonly ttsLoading = input(false);
  readonly streamingParts = input<StreamPart[]>([]);
  readonly streamingFinalText = input<string | undefined>(undefined);
  readonly streamingPlanner = input<PlannerProgress | null>(null);
  readonly fontSize = input(0.9);

  readonly restoreConversation = output<{ userMessageId?: string; userMessageIndex: number }>();
  readonly sendResponse = output<string>();
  /** Edited-files footer row clicked: open that file's read-only turn diff. */
  readonly openTurnDiff = output<TurnDiffOpenRequest>();
  readonly acceptCommandFinished = output<AcceptCommandFinishedEvent>();
  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly planConfirmFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly agentQuestionFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly themeProposalFinished = output<ThemeProposalFinishedEvent>();

  readonly chatContextFiles = input<readonly ChatContextFile[]>([]);
  readonly workspaceRoot = input('');
  readonly removeChatContextFile = output<ChatContextFile>();
  readonly togglePinChatContextFile = output<ChatContextFile>();
  readonly chatContextPathsDropped = output<ChatContextDroppedPath[]>();
  readonly attachmentCount = input(0);

  readonly appConfig = input<AppConfig | null>(null);
  readonly talkInputDeviceId = input('default');
  readonly talkSilenceThresholdSec = input(2);
  readonly talkEnabled = model(false);
  readonly talkStatus = model('');
  readonly talkModeDetailStatus = model('');
  readonly promptCaptured = output<string>();
  readonly talkRecordingBegan = output<void>();
  readonly talkCaptureFinished = output<{ hadSpeech: boolean; userBargeIn: boolean }>();

  readonly composerMode = model<ComposerRunMode>(DEFAULT_COMPOSER_RUN_MODE);
  readonly composerDraft = model('');
  readonly voiceActive = input(false);
  readonly voiceToggle = output<void>();
  readonly contextBlocked = input(false);
  readonly messageSent = output<string>();
  readonly abortRequested = output<void>();

  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly usedPercentage = input(0);
  readonly autoApplyMode = model(false);
  readonly adminElevationGranted = model(false);
  readonly adminElevationPending = input(false);
  readonly adminGrantRequested = output<void>();
  readonly reasoningEffortChange = output<LlmReasoningSettingChange>();

  protected readonly resolvedContainerSize = computed(() =>
    normalizeChatContainerSize(this.appConfig()?.chatContainerSize),
  );

  protected readonly resolvedThinkingDisplay = computed(() =>
    normalizeChatThinkingDisplay(this.appConfig()?.chatThinkingDisplay),
  );

  /** The running plan, pinned to the top of the composer (stages, questions, approval, steps). */
  readonly planDock = computed(() =>
    livePlanDockContext(this.messages(), this.streamingPlanner(), this.loading()),
  );

  /**
   * Pending HITL reviews for the slide-up composer dock. The plan's own questions and approval
   * move into the plan dock while it shows; a stale card after a reload still lands here.
   */
  readonly pendingHitlDockArtifacts = computed((): HitlTrailArtifact[] =>
    hitlDockArtifactsBesidePlan(
      pendingHitlArtifactsForDock(this.messages()) as HitlTrailArtifact[],
      this.planDock() != null,
    ),
  );

  // --- Sub-agent conversations: read-only, with a banner in place of the composer ---

  private readonly session = inject(ConversationSessionService);

  /** The conversation whose agent spawned the open one, when it is a sub-agent's. */
  protected readonly subagentParentId = computed(() =>
    this.conversationId() === this.session.activeConversationId() ? this.session.activeParentConversationId() : null,
  );

  protected readonly parentTitle = computed(() => {
    const parentId = this.subagentParentId();
    return this.session.conversations().find((c) => c.id === parentId)?.title ?? 'the main agent';
  });

  /** One of this sub-agent's approval cards is waiting in its parent's dock. */
  protected readonly subagentAwaitingApproval = computed(() => {
    const id = this.conversationId();
    return id != null && (this.session.pendingSubagentApprovals().get(id)?.length ?? 0) > 0;
  });

  protected openParent(parentId: string): void {
    this.session.openConversation(parentId);
  }

  /** A sub-agent pill in the transcript asked to open that sub-agent's conversation. */
  protected onOpenConversationRequested(event: Event): void {
    const id = (event as CustomEvent<unknown>).detail;
    if (typeof id === 'string' && id) {
      event.stopPropagation();
      this.session.openConversation(id);
    }
  }

  protected stopSubagent(): void {
    const id = this.conversationId();
    if (id) {
      this.session.stopSubagent(id);
    }
  }

  // --- Empty-state composer centering (expanded layout only) ---
  //
  // With no messages the transcript is empty, so in the expanded main-panel layout the composer
  // is taken out of flow (absolute, bottom-anchored) so the rounded panel fills the stack, then
  // lifted to the vertical center. In the sidebar layout the composer always rests at the bottom
  // edge. The first send (loading, then the user message) flips `isTranscriptEmpty()` to false,
  // the transform resets to `translateY(0)`, and the CSS `transform` transition eases the composer
  // down to the bottom edge. The lift distance is measured live so it tracks pane resizes. The
  // `ready` flag is set one frame after the first measurement so the initial centering does not
  // animate in.

  /** Composer region; its height (and the host's) drives the centering lift. */
  private readonly composerRef = viewChild<ElementRef<HTMLElement>>('composer');
  private readonly inj = inject(Injector);
  private readonly el = inject(ElementRef<HTMLElement>);
  private emptyStateResizeObserver: ResizeObserver | null = null;
  /** Guards against a pending measurement frame firing after the component is destroyed. */
  private emptyStateDestroyed = false;
  /** Frames spent waiting for the first usable layout before handing over to the ResizeObserver. */
  private emptyStateMeasureAttempts = 0;
  /** True once the frame that flips `emptyStateReady` has been requested. */
  private emptyStateReadyArmed = false;

  /**
   * True while the transcript has nothing to show. `loading` is included because
   * `prepareForSend` flips it on before the user message is pushed — the live-turn
   * shell already occupies the transcript during that gap.
   */
  private readonly isTranscriptEmpty = computed(
    () => this.messages().length === 0 && !this.loading(),
  );

  /** Etched mark in the expanded main-panel chat when the transcript is empty. */
  protected readonly showBrandEtch = computed(
    () => this.layout() === 'expanded' && this.isTranscriptEmpty(),
  );

  /**
   * True once the first height measurement has landed. Gates the CSS transform transition so the
   * initial centering (applied before this flips) does not animate in on load.
   */
  protected readonly emptyStateReady = signal(false);

  /** Measured lift (px) that centers the composer in the empty stack. */
  private readonly composerEmptyOffsetPx = signal(0);

  /**
   * Transform applied to the composer: in the expanded layout it lifts the message box to the
   * vertical center while the transcript is empty; in the sidebar layout (and whenever messages
   * exist) it is `translateY(0)` (rests at the bottom edge). Bound on the composer `<section>`.
   * Both states are `translateY` values so the transition interpolates smoothly in both
   * directions. Not gated by `emptyStateReady` on purpose — the offset is measured in
   * `afterNextRender` (before the transition is enabled), so the load centering is a non-animated
   * snap.
   */
  protected readonly composerTransform = computed(() =>
    this.layout() === 'expanded' && this.isTranscriptEmpty()
      ? `translateY(calc(-1 * ${this.composerEmptyOffsetPx()}px))`
      : 'translateY(0)',
  );

  constructor() {
    afterNextRender(
      () => {
        this.scheduleComposerEmptyOffset();
        if (typeof ResizeObserver === 'undefined') {
          return;
        }
        this.emptyStateResizeObserver?.disconnect();
        const onResize = () => this.syncComposerEmptyOffset();
        this.emptyStateResizeObserver = new ResizeObserver(onResize);
        // Observe both the host (always present) and the composer: a ResizeObserver fires once
        // immediately on `observe` with the element's current size, so this recovers the lift even
        // if the layout is not settled at the first render pass, and re-measures on any resize.
        this.emptyStateResizeObserver.observe(this.el.nativeElement);
        const composer = this.composerRef()?.nativeElement;
        if (composer) {
          this.emptyStateResizeObserver.observe(composer);
        }
      },
      { injector: this.inj },
    );
  }

  /** Frames to retry the initial measurement before leaving it to the ResizeObserver. */
  private static readonly EMPTY_STATE_MEASURE_MAX_FRAMES = 30;

  /**
   * Measure the centering lift, retrying (one frame at a time, bounded) until the stack reports
   * a usable height. Backs up the host/composer `ResizeObserver` when the first pass lands before
   * layout. The retry is capped so a host that stays unlaid-out (hidden ancestor) does not keep
   * an animation-frame loop alive; the observer picks the measurement up once it gets a size.
   */
  private scheduleComposerEmptyOffset(): void {
    if (this.emptyStateDestroyed) {
      return;
    }
    if (this.syncComposerEmptyOffset()) {
      return;
    }
    if (this.emptyStateMeasureAttempts >= ChatActiveStackComponent.EMPTY_STATE_MEASURE_MAX_FRAMES) {
      return;
    }
    this.emptyStateMeasureAttempts += 1;
    // zone.js patches `requestAnimationFrame`, so this runs inside the Angular zone.
    requestAnimationFrame(() => this.scheduleComposerEmptyOffset());
  }

  /**
   * Enable the transform transition one frame after the first successful measurement, so the
   * initial centering paints in place rather than animating in on load.
   */
  private armEmptyStateReady(): void {
    if (this.emptyStateReadyArmed || this.emptyStateReady()) {
      return;
    }
    this.emptyStateReadyArmed = true;
    requestAnimationFrame(() => {
      if (!this.emptyStateDestroyed) {
        this.emptyStateReady.set(true);
      }
    });
  }

  /**
   * Recompute the centering lift. The composer sits at the bottom of the stack, so lifting it by
   * half the gap between the host and the composer moves its center to the stack's vertical
   * center. `offsetHeight`/`clientHeight` are unaffected by the transform.
   *
   * A zero lift is a successful measurement (composer fills the stack — common in the sidebar).
   *
   * @returns `true` once host and composer have a usable laid-out height.
   */
  private syncComposerEmptyOffset(): boolean {
    const host = this.el.nativeElement;
    const composer = this.composerRef()?.nativeElement;
    if (!composer || host.clientHeight <= 0) {
      return false;
    }
    const offset = Math.max(0, (host.clientHeight - composer.offsetHeight) / 2);
    this.composerEmptyOffsetPx.set(offset);
    this.armEmptyStateReady();
    return true;
  }

  ngOnDestroy(): void {
    this.emptyStateDestroyed = true;
    this.emptyStateResizeObserver?.disconnect();
    this.emptyStateResizeObserver = null;
  }

  protected readonly dragActive = signal(false);

  protected onDragOver(event: DragEvent): void {
    if (handleChatContextDragOver(event)) {
      this.dragActive.set(true);
    }
  }

  protected onDragLeave(event: DragEvent): void {
    const related = event.relatedTarget;
    const host = event.currentTarget;
    if (related instanceof Node && host instanceof Node && host.contains(related)) {
      return;
    }
    this.dragActive.set(false);
  }

  protected onDrop(event: DragEvent): void {
    this.dragActive.set(false);
    const paths = handleChatContextDrop(event);
    if (paths.length > 0) {
      this.chatContextPathsDropped.emit(paths);
    }
  }
}
