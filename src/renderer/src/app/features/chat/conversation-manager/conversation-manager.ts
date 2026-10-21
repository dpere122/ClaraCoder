import { Component, computed, HostListener, input, output, signal, ViewEncapsulation } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { ConversationMeta } from '@shared/index';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { turnActivitySpinnerSrc, type TurnActivity } from '../chat-box/chat-box';
import { buildConversationTree, type ConversationTreeNode } from './conversation-tree';

/** Screen-reader label for each live turn activity shown on a conversation row. */
const ACTIVITY_LABELS: Record<TurnActivity, string> = {
  prefill: 'Processing prompt',
  think: 'Thinking',
  read: 'Reading files',
  write: 'Running tools',
  run: 'Running a command',
  web: 'Browsing the web',
  reply: 'Writing reply',
  review: 'Waiting for your review',
};

@Component({
  selector: 'app-conversation-manager',
  imports: [FormsModule, LucideAngularModule, NgTemplateOutlet],
  templateUrl: './conversation-manager.html',
  styleUrl: './conversation-manager.css',
  encapsulation: ViewEncapsulation.None,
})
export class ConversationManager {
  readonly conversations = input<ConversationMeta[]>([]);
  readonly activeId = input<string | null>(null);
  /** Live turn activity per streaming conversation; rows not in the map are idle. */
  readonly activity = input<ReadonlyMap<string, TurnActivity>>(new Map());

  readonly selectConversation = output<string>();
  readonly deleteConversation = output<string>();
  readonly renameConversation = output<{ id: string; title: string }>();

  /** Top-level conversations with their sub-agent conversations nested under them. */
  protected readonly tree = computed(() => buildConversationTree(this.conversations()));
  /** Parents the user expanded (`true`) or collapsed (`false`); others follow {@link isExpanded}'s default. */
  private readonly expandOverrides = signal<ReadonlyMap<string, boolean>>(new Map());

  protected editingId = signal<string | null>(null);
  protected editTitle = signal('');
  protected contextMenuVisible = signal(false);
  protected contextMenuX = signal(0);
  protected contextMenuY = signal(0);
  protected contextMenuConvId = signal<string | null>(null);

  protected activitySpinnerSrc(activity: TurnActivity): string | null {
    return turnActivitySpinnerSrc(activity);
  }

  protected activityLabel(activity: TurnActivity): string {
    return ACTIVITY_LABELS[activity];
  }

  /**
   * Sub-agents show by default while they matter: the parent or one of them is open, or one is
   * still running. Otherwise they fold away so finished delegations do not crowd the list.
   */
  protected isExpanded(node: ConversationTreeNode): boolean {
    const override = this.expandOverrides().get(node.conversation.id);
    if (override !== undefined) {
      return override;
    }
    const active = this.activeId();
    const activity = this.activity();
    return (
      node.conversation.id === active ||
      node.children.some((c) => c.id === active || activity.has(c.id))
    );
  }

  protected toggleExpanded(node: ConversationTreeNode, event: Event): void {
    event.stopPropagation();
    const next = !this.isExpanded(node);
    this.expandOverrides.update((map) => new Map(map).set(node.conversation.id, next));
  }

  startRename(conv: ConversationMeta, event?: Event): void {
    event?.stopPropagation();
    this.closeContextMenu();
    this.editingId.set(conv.id);
    this.editTitle.set(conv.title);
  }

  onConvContextMenu(event: MouseEvent, conv: ConversationMeta): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.editingId() === conv.id) {
      return;
    }
    this.contextMenuConvId.set(conv.id);
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);
  }

  onContextMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onContextMenuRename(): void {
    const id = this.contextMenuConvId();
    const conv = this.conversations().find((c) => c.id === id);
    this.closeContextMenu();
    if (!conv) {
      return;
    }
    this.startRename(conv);
  }

  onContextMenuDelete(): void {
    const id = this.contextMenuConvId();
    this.closeContextMenu();
    if (!id) {
      return;
    }
    this.deleteConversation.emit(id);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.contextMenuVisible()) {
      return;
    }
    const inside = ev
      .composedPath()
      .some((n) => n instanceof HTMLElement && n.classList.contains('conv-context-menu'));
    if (inside) {
      return;
    }
    this.closeContextMenu();
  }

  @HostListener('document:keydown.escape')
  onEscapeCloseContextMenu(): void {
    if (this.contextMenuVisible()) {
      this.closeContextMenu();
    }
  }

  confirmRename(id: string): void {
    const title = this.editTitle().trim();
    if (title) {
      this.renameConversation.emit({ id, title });
    }
    this.editingId.set(null);
  }

  cancelRename(): void {
    this.editingId.set(null);
  }

  onDelete(id: string, event: Event): void {
    event.stopPropagation();
    this.deleteConversation.emit(id);
  }

  private closeContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuConvId.set(null);
  }
}
