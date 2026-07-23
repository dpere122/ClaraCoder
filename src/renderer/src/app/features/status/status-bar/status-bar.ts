import { Component, inject, input } from '@angular/core';
import { WorkspaceFileChangeStatusService } from '../../../core/workspace-file-change-status.service';

@Component({
  selector: 'app-status-bar',
  imports: [],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
})
export class StatusBarComponent {
  protected readonly workspaceFileChange = inject(WorkspaceFileChangeStatusService);
  readonly compressionNotice = input('');
}
