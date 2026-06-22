import { Component, input, output } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-main-panel-empty-state',
  imports: [LucideAngularModule],
  templateUrl: './main-panel-empty-state.html',
  styleUrl: './main-panel-empty-state.css',
})
export class MainPanelEmptyStateComponent {
  readonly hasWorkspace = input(false);
  readonly addWorkspace = output<void>();
}
