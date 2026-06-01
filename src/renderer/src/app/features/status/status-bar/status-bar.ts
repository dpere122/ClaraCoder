import { Component, inject, input, model, output } from '@angular/core';
import { WorkspaceFileChangeStatusService } from '../../../core/workspace-file-change-status.service';
import { ContextCapacityComponent, type LlmModelPresetOption } from '../context-capacity/context-capacity';

@Component({
  selector: 'app-status-bar',
  imports: [ContextCapacityComponent],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
})
export class StatusBarComponent {
  protected readonly workspaceFileChange = inject(WorkspaceFileChangeStatusService);
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly modelName = input('Unknown model');
  readonly modelPresetOptions = input<LlmModelPresetOption[]>([]);
  readonly activeLlmModelId = input('');
  readonly activeLlmModelChange = output<string>();
  readonly usedPercentage = input(0);
  readonly compressionNotice = input('');
  readonly editorMode = model(true);
  readonly autoApplyMode = model(false);
}
