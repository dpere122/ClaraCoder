import { Component, effect, inject, input, output, signal, ViewEncapsulation } from '@angular/core';
import type { ConversationMeta } from '@shared/index';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';

const CONV_PENDING_INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-secondary-color)',
};

@Component({
  selector: 'app-conversation-manager',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent],
  templateUrl: './conversation-manager.html',
  styleUrl: './conversation-manager.css',
  encapsulation: ViewEncapsulation.None
})
export class ConversationManager {
  private readonly ngxSpinner = inject(NgxSpinnerService);

  readonly conversations = input<ConversationMeta[]>([]);
  readonly activeId = input<string | null>(null);
  readonly pendingIds = input<Set<string>>(new Set());

  readonly newConversation = output<void>();
  readonly selectConversation = output<string>();
  readonly deleteConversation = output<string>();
  readonly renameConversation = output<{ id: string; title: string }>();

  protected editingId = signal<string | null>(null);
  protected editTitle = signal('');

  constructor() {
    effect(() => {
      const pending = this.pendingIds();
      for (const c of this.conversations()) {
        const name = this.convPendingSpinnerName(c.id);
        if (pending.has(c.id)) {
          void this.ngxSpinner.show(name, {
            ...CONV_PENDING_INLINE_SPINNER,
            type: 'ball-clip-rotate-pulse',
          });
        } else {
          void this.ngxSpinner.hide(name);
        }
      }
    });
  }

  protected convPendingSpinnerName(id: string): string {
    return `conv-pending-${id}`;
  }

  startRename(conv: ConversationMeta, event: Event): void {
    event.stopPropagation();
    this.editingId.set(conv.id);
    this.editTitle.set(conv.title);
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
}
