import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import {
  type ChatContextFile,
  WORKSPACE_TREE_DRAG_MIME,
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
  readonly pathsDropped = output<string[]>();

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

  protected thumbnailFor(file: ChatContextFile): string | null {
    return this.thumbnails()[file.relativePath] ?? null;
  }

  protected onRemove(file: ChatContextFile): void {
    this.removeFile.emit(file);
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    const types = Array.from(event.dataTransfer.types ?? []);
    if (!types.includes(WORKSPACE_TREE_DRAG_MIME) && !types.includes('text/plain')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragActive.set(true);
  }

  protected onDragLeave(): void {
    this.dragActive.set(false);
  }

  protected onDrop(event: DragEvent): void {
    this.dragActive.set(false);
    const dt = event.dataTransfer;
    if (!dt) {
      return;
    }
    const raw = dt.getData(WORKSPACE_TREE_DRAG_MIME) || dt.getData('text/plain');
    if (!raw) {
      return;
    }
    event.preventDefault();
    const paths = raw
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paths.length > 0) {
      this.pathsDropped.emit(paths);
    }
  }

  private async loadThumbnail(root: string, relativePath: string): Promise<void> {
    try {
      const res = await this.electron.readWorkspaceImageBase64(root, relativePath);
      if (res.ok && res.dataUrl) {
        this.thumbnails.update((prev) => ({ ...prev, [relativePath]: res.dataUrl as string }));
      }
    } catch {
      // Ignore: chip falls back to the generic image icon.
    }
  }
}
