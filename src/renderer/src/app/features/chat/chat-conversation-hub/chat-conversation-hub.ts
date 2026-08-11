import { Component, input, model, output } from '@angular/core';
import type { AppConfig, ComposerRunMode, ConversationMeta, PlannerProgress, StreamPart } from '@shared/index';
import { DEFAULT_COMPOSER_RUN_MODE } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { ConversationManager } from '../conversation-manager/conversation-manager';
import { ChatActiveStackComponent } from '../chat-active-stack/chat-active-stack';
import type { ChatMessage } from '../chat-box/chat-box';
import type { ChatContextFile } from '../chat-context-bar/chat-context-file';
import type { ChatContextDroppedPath } from '../chat-context-bar/chat-context-drop';

export type ChatHubView = 'conversations' | 'activeChat';

@Component({
  selector: 'app-chat-conversation-hub',
  imports: [LucideAngularModule, ConversationManager, ChatActiveStackComponent],
  templateUrl: './chat-conversation-hub.html',
  styleUrl: './chat-conversation-hub.css',
})
export class ChatConversationHubComponent {
  readonly view = model<ChatHubView>('activeChat');
  readonly expanded = model(false);
  /** When true, the entire chat sidebar collapses to a thin bar with only the un-collapse button. */
  readonly collapsed = model(false);

  readonly conversations = input<ConversationMeta[]>([]);
  readonly activeConversationId = input<string | null>(null);
  readonly activeFileRelativePath = input<string | null>(null);
  readonly pendingIds = input<Set<string>>(new Set());
  readonly hasWorkspace = input(false);

  readonly newConversation = output<void>();
  readonly selectConversation = output<string>();
  readonly deleteConversation = output<string>();
  readonly renameConversation = output<{ id: string; title: string }>();

  readonly messages = input<ChatMessage[]>([]);
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

  protected toggleExpanded(): void {
    if (this.view() !== 'activeChat') {
      return;
    }
    this.expanded.update((v) => !v);
  }

  protected toggleCollapsed(): void {
    if (this.collapsed()) {
      this.collapsed.set(false);
      return;
    }
    // Collapsing the sidebar also closes the expanded overlay so the editor
    // stage stays usable and there's no dangling expanded state with no
    // visible toolbar to un-expand it.
    this.expanded.set(false);
    this.collapsed.set(true);
  }

  protected toggleView(): void {
    if (this.view() === 'conversations') {
      this.view.set('activeChat');
      return;
    }
    this.expanded.set(false);
    this.view.set('conversations');
  }

  protected onSelectFromList(id: string): void {
    this.selectConversation.emit(id);
    this.view.set('activeChat');
  }
}
