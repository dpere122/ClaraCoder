import { NgTemplateOutlet } from '@angular/common';
import { Component, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { isFavoriteWorkspace, sortFavoriteWorkspaces, type Workspace } from '@shared/index';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-workspaces',
  imports: [LucideAngularModule, NgTemplateOutlet],
  templateUrl: './settings-workspaces.html',
  styleUrl: './settings-workspaces.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsWorkspaces {
  protected readonly s = inject(SettingsStore);

  /** Workspace shown in the detail panel; independent of which workspace is active. */
  private readonly viewedId = signal<string | null>(null);

  /** Falls back to the active workspace, then the first one, when nothing (or a removed one) is picked. */
  protected readonly viewed = computed<Workspace | null>(() => {
    const list = this.s.workspaces();
    const id = this.viewedId();
    return list.find((w) => w.id === id) ?? this.s.currentWorkspace() ?? list[0] ?? null;
  });

  /** Favorites in their saved order; the rest keep the order they were added in. */
  protected readonly favorites = computed(() => sortFavoriteWorkspaces(this.s.workspaces()));
  protected readonly others = computed(() => this.s.workspaces().filter((w) => !isFavoriteWorkspace(w)));

  protected isActive(workspace: Workspace): boolean {
    return workspace.id === this.s.currentWorkspace()?.id;
  }

  protected view(id: string): void {
    this.viewedId.set(id);
  }

  protected async add(): Promise<void> {
    const id = await this.s.addWorkspace();
    if (id) {
      this.viewedId.set(id);
    }
  }

  protected async remove(id: string): Promise<void> {
    if ((await this.s.removeWorkspace(id)) && this.viewedId() === id) {
      this.viewedId.set(null);
    }
  }

  protected formatDate(iso: string | undefined): string {
    if (!iso) {
      return 'Never';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? 'Unknown'
      : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}
