import { Component, computed, input, output } from '@angular/core';
import type { Workspace } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';

const RECENT_WORKSPACE_LIMIT = 6;

@Component({
  selector: 'app-main-panel-empty-state',
  imports: [LucideAngularModule],
  templateUrl: './main-panel-empty-state.html',
  styleUrl: './main-panel-empty-state.css',
})
export class MainPanelEmptyStateComponent {
  readonly hasWorkspace = input(false);
  readonly recentWorkspaces = input<readonly Workspace[]>([]);
  readonly addWorkspace = output<void>();
  readonly openWorkspace = output<string>();
  readonly openModelManager = output<void>();
  readonly openDependencies = output<void>();

  readonly visibleRecents = computed(() => this.recentWorkspaces().slice(0, RECENT_WORKSPACE_LIMIT));
}
