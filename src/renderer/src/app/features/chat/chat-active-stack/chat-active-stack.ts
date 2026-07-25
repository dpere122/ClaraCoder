import { Component, computed, input, model, output, signal } from '@angular/core';
import type {
  AppConfig,
  ComposerRunMode,
  HitlTrailArtifact,
  PlannerProgress,
  StreamPart,
} from '@shared/index';
import { DEFAULT_COMPOSER_RUN_MODE, normalizeChatContainerSize } from '@shared/index';
import { ChatBox, pendingHitlArtifactsForDock, type ChatMessage } from '../chat-box/chat-box';
import { ChatContextBar } from '../chat-context-bar/chat-context-bar';
import { handleChatContextDragOver, handleChatContextDrop, type ChatContextDroppedPath } from '../chat-context-bar/chat-context-drop';
import { type ChatContextFile } from '../chat-context-bar/chat-context-file';
import { HitlComposerDockComponent } from '../hitl-composer-dock/hitl-composer-dock';
import { MessageBox } from '../message-box/message-box';
import { TalkMode } from '../../speech/talk-mode/talk-mode';
export type ChatLayoutMode = 'sidebar' | 'expanded';

/** Chat transcript, composer, and status bar — shared by sidebar hub and expanded main overlay. */
@Component({
  selector: 'app-chat-active-stack',
  imports: [ChatBox, ChatContextBar, HitlComposerDockComponent, MessageBox, TalkMode],
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
  },
})
export class ChatActiveStackComponent {
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

  readonly sendResponse = output<string>();
  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly stagedTransferBatchFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }>();
  readonly stagedTransferBatchFileResolved = output<{
    requestId: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }>();
  readonly acceptCommandFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly copyReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
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

  protected readonly resolvedContainerSize = computed(() =>
    normalizeChatContainerSize(this.appConfig()?.chatContainerSize),
  );

  /** Pending HITL reviews for the slide-up composer dock (all roles including plan/question). */
  readonly pendingHitlDockArtifacts = computed((): HitlTrailArtifact[] =>
    pendingHitlArtifactsForDock(this.messages()) as HitlTrailArtifact[],
  );

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
