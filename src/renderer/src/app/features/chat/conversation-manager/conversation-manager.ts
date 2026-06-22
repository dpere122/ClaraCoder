import { Component, inject, input, output, signal, ViewEncapsulation } from '@angular/core';
import type { ConversationMeta } from '@shared/index';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { EditorLspStatusComponent } from '../../shell/editor-lsp-status/editor-lsp-status';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-conversation-manager',
  imports: [FormsModule, LucideAngularModule, EditorLspStatusComponent],
  templateUrl: './conversation-manager.html',
  styleUrl: './conversation-manager.css',
  encapsulation: ViewEncapsulation.None
})
export class ConversationManager {
  protected readonly electron = inject(ElectronService);

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
