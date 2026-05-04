import { Component, input, model, output } from '@angular/core';
import { ContextCapacityComponent, type LlmModelPresetOption } from '../context-capacity/context-capacity';

@Component({
  selector: 'app-status-bar',
  imports: [ContextCapacityComponent],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
})
export class StatusBarComponent {
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly modelName = input('Unknown model');
  readonly modelPresetOptions = input<LlmModelPresetOption[]>([]);
  readonly activeLlmModelId = input('');
  readonly activeLlmModelChange = output<string>();
  readonly usedPercentage = input(0);
  readonly editorMode = model(true);
  readonly autoApplyMode = model(false);
}
