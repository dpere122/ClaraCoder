import { Component, computed, input, output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import type { AppConfig, Workspace } from '@shared/index';
import {
  formatWorkspaceLastOpenedLabel,
  isFavoriteWorkspace,
  sortFavoriteWorkspaces,
  sortNonFavoriteWorkspaces,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { LlamaStatusIndicator } from '../../status/llama-status-indicator/llama-status-indicator';
import { ManagedLlamaControlsComponent } from '../../status/managed-llama-controls/managed-llama-controls';

@Component({
  selector: 'app-main-panel-empty-state',
  imports: [
    LucideAngularModule,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    ManagedLlamaControlsComponent,
    LlamaStatusIndicator,
  ],
  templateUrl: './main-panel-empty-state.html',
  styleUrl: './main-panel-empty-state.css',
})
export class MainPanelEmptyStateComponent {
  readonly hasWorkspace = input(false);
  readonly recentWorkspaces = input<readonly Workspace[]>([]);
  readonly defaultHomePage = input(false);
  /** Drives the Runtime panel (source picker, Start/Stop, model and embeddings status). */
  readonly appConfig = input<AppConfig | null>(null);
  /** Dev bridge tab only: the workspace the app's main window has open, offered as "Join". */
  readonly mainWindowWorkspace = input<Workspace | null>(null);
  readonly joinMainWindow = output<void>();
  readonly addWorkspace = output<void>();
  readonly openWorkspace = output<string>();
  readonly toggleFavorite = output<string>();
  readonly reorderFavorites = output<string[]>();
  readonly openModelManager = output<void>();
  readonly openDependencies = output<void>();
  readonly defaultHomePageChange = output<boolean>();

  readonly favoriteWorkspaces = computed(() => sortFavoriteWorkspaces(this.recentWorkspaces()));
  readonly recentOnlyWorkspaces = computed(() => sortNonFavoriteWorkspaces(this.recentWorkspaces()));
  readonly lastOpenedById = computed(() => {
    const now = Date.now();
    return new Map(
      this.recentOnlyWorkspaces().map((ws) => [ws.id, formatWorkspaceLastOpenedLabel(ws, now)] as const),
    );
  });

  /** No model sources yet: the source picker hides itself, so offer a way to add one. */
  protected readonly hasSources = computed(() => (this.appConfig()?.llmProviders?.length ?? 0) > 0);

  protected isFavorite(ws: Workspace): boolean {
    return isFavoriteWorkspace(ws);
  }

  onDefaultHomePageChange(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    this.defaultHomePageChange.emit(input.checked);
  }

  onFavoriteDrop(event: CdkDragDrop<Workspace[]>): void {
    if (event.previousIndex === event.currentIndex) {
      return;
    }
    const ids = this.favoriteWorkspaces().map((ws) => ws.id);
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.reorderFavorites.emit(ids);
  }
}
