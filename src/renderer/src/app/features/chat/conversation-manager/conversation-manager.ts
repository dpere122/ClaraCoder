import { Component, computed, DestroyRef, HostListener, inject, input, output, signal, ViewEncapsulation } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { ConversationMeta } from '@shared/index';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { turnActivitySpinnerKind, type TurnActivity } from '../chat-box/chat-box';
import { ToolSpinnerComponent } from '../chat-box/tool-spinner/tool-spinner';
import type { SpinnerKind } from '../chat-box/tool-spinner-kind';
import {
  buildConversationTree,
  conversationAgeLabel,
  filterConversationTree,
  groupConversationTreeByDate,
  type ConversationTreeNode,
  type FilteredConversationTreeNode,
} from './conversation-tree';

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

/** True for a parent the name filter kept only for its matching sub-agents. */
function isForceExpanded(node: ConversationTreeNode | FilteredConversationTreeNode): boolean {
  return 'forceExpanded' in node && node.forceExpanded;
}

@Component({
  selector: 'app-conversation-manager',
  imports: [FormsModule, LucideAngularModule, NgTemplateOutlet, ToolSpinnerComponent],
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
  /** Name filter typed above the list; matches titles only (message search comes later). */
  protected readonly filterQuery = signal('');
  protected readonly filteredTree = computed(() => filterConversationTree(this.tree(), this.filterQuery()));
  /** Ticks once a minute so ages and date sections stay current while the list is open. */
  private readonly now = signal(new Date());
  protected readonly sections = computed(() => groupConversationTreeByDate(this.filteredTree(), this.now()));
  protected readonly footerLabel = computed(() => {
    const total = this.tree().length;
    const noun = total === 1 ? 'conversation' : 'conversations';
    if (!this.filterQuery().trim()) {
      return `${total} ${noun}`;
    }
    return `${this.filteredTree().length} of ${total} ${noun}`;
  });
  /** Parents the user expanded (`true`) or collapsed (`false`); others follow {@link isExpanded}'s default. */
  private readonly expandOverrides = signal<ReadonlyMap<string, boolean>>(new Map());
  /**
   * Toggles on parents the filter forced open, kept apart from {@link expandOverrides} so an earlier
   * collapse cannot hide the matches; reset whenever the filter text changes.
   */
  private readonly filterExpandOverrides = signal<ReadonlyMap<string, boolean>>(new Map());

  protected editingId = signal<string | null>(null);
  protected editTitle = signal('');
  protected contextMenuVisible = signal(false);
  protected contextMenuX = signal(0);
  protected contextMenuY = signal(0);
  protected contextMenuConvId = signal<string | null>(null);

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected age(conv: ConversationMeta): string {
    return conversationAgeLabel(conv.updatedAt, this.now());
  }

  protected setFilter(query: string): void {
    this.filterQuery.set(query);
    this.filterExpandOverrides.set(new Map());
  }

  protected clearFilter(event: Event): void {
    event.stopPropagation();
    this.setFilter('');
  }

  protected activitySpinnerKind(activity: TurnActivity): SpinnerKind | null {
    return turnActivitySpinnerKind(activity);
  }

  protected activityLabel(activity: TurnActivity): string {
    return ACTIVITY_LABELS[activity];
  }

  /**
   * Sub-agents show by default while they matter: the parent or one of them is open, or one is
   * still running. Otherwise they fold away so finished delegations do not crowd the list. A parent
   * kept by the filter only for its matching sub-agents opens so the matches show, whatever the user
   * chose for it before filtering.
   */
  protected isExpanded(node: ConversationTreeNode | FilteredConversationTreeNode): boolean {
    if (isForceExpanded(node)) {
      return this.filterExpandOverrides().get(node.conversation.id) ?? true;
    }
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

  protected toggleExpanded(node: ConversationTreeNode | FilteredConversationTreeNode, event: Event): void {
    event.stopPropagation();
    const next = !this.isExpanded(node);
    const overrides = isForceExpanded(node) ? this.filterExpandOverrides : this.expandOverrides;
    overrides.update((map) => new Map(map).set(node.conversation.id, next));
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
