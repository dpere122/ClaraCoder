import { Component, computed, input, output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import type { Workspace } from '@shared/index';
import {
  formatWorkspaceLastOpenedLabel,
  isFavoriteWorkspace,
  sortFavoriteWorkspaces,
  sortNonFavoriteWorkspaces,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-main-panel-empty-state',
  imports: [LucideAngularModule, CdkDropList, CdkDrag, CdkDragHandle],
  templateUrl: './main-panel-empty-state.html',
  styleUrl: './main-panel-empty-state.css',
})
export class MainPanelEmptyStateComponent {
  readonly hasWorkspace = input(false);
  readonly recentWorkspaces = input<readonly Workspace[]>([]);
  readonly defaultHomePage = input(false);
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
