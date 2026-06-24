import {
  Component,
  effect,
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

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const conv of this.conversations()) {
      void this.ngxSpinner.hide(this.convPendingSpinnerName(conv.id));
    }
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
