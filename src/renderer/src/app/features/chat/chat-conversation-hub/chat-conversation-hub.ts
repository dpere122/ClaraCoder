import { Component, input, model, output } from '@angular/core';
import type { AppConfig, ComposerRunMode, ConversationMeta, PlannerProgress, StreamPart } from '@shared/index';
import { DEFAULT_COMPOSER_RUN_MODE } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { ConversationManager } from '../conversation-manager/conversation-manager';
import { ChatActiveStackComponent } from '../chat-active-stack/chat-active-stack';
import type { ChatMessage } from '../chat-box/chat-box';
import type { ChatContextFile } from '../chat-context-bar/chat-context-file';
import type { LlmModelPresetOption } from '../../status/context-capacity/context-capacity';

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

  readonly conversations = input<ConversationMeta[]>([]);
  readonly activeConversationId = input<string | null>(null);
  readonly activeFileRelativePath = input<string | null>(null);
  readonly pendingIds = input<Set<string>>(new Set());

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

  readonly chatContextFiles = input<readonly ChatContextFile[]>([]);
  readonly workspaceRoot = input('');
  readonly removeChatContextFile = output<ChatContextFile>();
  readonly chatContextPathsDropped = output<string[]>();

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
  readonly compressionNotice = input('');
  readonly modelName = input('Unknown model');
  readonly modelPresetOptions = input<LlmModelPresetOption[]>([]);
  readonly activeLlmModelId = input('');
  readonly activeLlmModelChange = output<string>();
  readonly editorMode = model(true);
  readonly autoApplyMode = model(false);

  protected toggleExpanded(): void {
    if (this.view() !== 'activeChat') {
      return;
    }
    this.expanded.update((v) => !v);
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
