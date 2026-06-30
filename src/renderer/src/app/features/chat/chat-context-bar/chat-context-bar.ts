import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import { handleChatContextDragOver, handleChatContextDrop, type ChatContextDroppedPath } from './chat-context-drop';
import {
  chatContextFileKey,
  formatChatContextChipLabel,
  formatChatContextChipTitle,
  type ChatContextFile,
} from './chat-context-file';

/** Bar above the composer holding files attached to the next turn (images preview inline). */
@Component({
  selector: 'app-chat-context-bar',
  imports: [LucideAngularModule],
  templateUrl: './chat-context-bar.html',
  styleUrl: './chat-context-bar.css',
})
export class ChatContextBar {
  private readonly electron = inject(ElectronService);

  readonly files = input<readonly ChatContextFile[]>([]);
  readonly workspaceRoot = input('');

  readonly removeFile = output<ChatContextFile>();
  readonly togglePinFile = output<ChatContextFile>();
  readonly pathsDropped = output<ChatContextDroppedPath[]>();

  protected readonly dragActive = signal(false);
  /** Thumbnail data URLs keyed by relative path (lazy-loaded for image attachments). */
  private readonly thumbnails = signal<Record<string, string>>({});

  protected readonly hasFiles = computed(() => this.files().length > 0);

  constructor() {
    effect(() => {
      const root = this.workspaceRoot();
      const files = this.files();
      if (!root) {
        return;
      }
      const loaded = this.thumbnails();
      for (const file of files) {
        if (file.kind !== 'image' || loaded[file.relativePath]) {
          continue;
        }
        void this.loadThumbnail(root, file.relativePath);
      }
    });
  }

  protected contextKey(file: ChatContextFile): string {
    return chatContextFileKey(file);
  }

  protected hasLineRange(file: ChatContextFile): boolean {
    return file.source === 'editor' && !!file.lineRange;
  }

  protected isPinned(file: ChatContextFile): boolean {
    return !!file.pinned;
  }

  protected chipLabel(file: ChatContextFile): string {
    return formatChatContextChipLabel(file);
  }

  protected chipTitle(file: ChatContextFile): string {
    return formatChatContextChipTitle(file);
  }

  protected thumbnailFor(file: ChatContextFile): string | null {
    return this.thumbnails()[file.relativePath] ?? null;
  }

  protected onRemove(file: ChatContextFile): void {
    this.removeFile.emit(file);
  }

  protected onTogglePin(file: ChatContextFile): void {
    this.togglePinFile.emit(file);
  }

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
      this.pathsDropped.emit(paths);
    }
  }

  private async loadThumbnail(root: string, relativePath: string): Promise<void> {
    const res = await this.electron.readWorkspaceImageBase64(root, relativePath);
    if (!res.ok || !res.dataUrl) {
      return;
    }
    this.thumbnails.update((m) => ({ ...m, [relativePath]: res.dataUrl! }));
  }
}
