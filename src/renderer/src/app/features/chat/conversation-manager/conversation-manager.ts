import {
  Component,
  effect,
  HostListener,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  ViewEncapsulation,
  afterNextRender,
} from '@angular/core';
import type { ConversationMeta } from '@shared/index';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import { EditorLspStatusComponent } from '../../shell/editor-lsp-status/editor-lsp-status';
import { ElectronService } from '../../../core/electron.service';

const CONV_PENDING_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-secondary-color)',
  type: 'ball-atom' as const,
};

@Component({
  selector: 'app-conversation-manager',
  imports: [FormsModule, LucideAngularModule, EditorLspStatusComponent, NgxSpinnerComponent],
  templateUrl: './conversation-manager.html',
  styleUrl: './conversation-manager.css',
  encapsulation: ViewEncapsulation.None,
})
export class ConversationManager implements OnDestroy {
  protected readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  private destroyed = false;

  readonly conversations = input<ConversationMeta[]>([]);
  readonly activeId = input<string | null>(null);
  readonly pendingIds = input<Set<string>>(new Set());
  readonly activeFileRelativePath = input<string | null>(null);

  readonly newConversation = output<void>();
  readonly selectConversation = output<string>();
  readonly deleteConversation = output<string>();
  readonly renameConversation = output<{ id: string; title: string }>();

  protected editingId = signal<string | null>(null);
  protected editTitle = signal('');
  protected contextMenuVisible = signal(false);
  protected contextMenuX = signal(0);
  protected contextMenuY = signal(0);
  protected contextMenuConvId = signal<string | null>(null);

  constructor() {
    effect(() => {
      const pending = this.pendingIds();
      const conversations = this.conversations();
      untracked(() => this.scheduleConvPendingSpinnerSync(pending, conversations));
    });
  }

  protected convPendingSpinnerName(id: string): string {
    return `conv-pending-${id}`;
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

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const conv of this.conversations()) {
      void this.ngxSpinner.hide(this.convPendingSpinnerName(conv.id));
    }
  }

  private closeContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuConvId.set(null);
  }

  private scheduleConvPendingSpinnerSync(pending: Set<string>, conversations: ConversationMeta[]): void {
    afterNextRender(
      () => {
        if (this.destroyed) {
          return;
        }
        for (const conv of conversations) {
          const name = this.convPendingSpinnerName(conv.id);
          if (pending.has(conv.id)) {
            void this.ngxSpinner.show(name, CONV_PENDING_SPINNER);
          } else {
            void this.ngxSpinner.hide(name);
          }
        }
      },
      { injector: this.inj },
    );
  }
}
