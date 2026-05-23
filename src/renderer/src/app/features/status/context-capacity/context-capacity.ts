import { Component, computed, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorMode } from '../../layout/editor-mode/editor-mode';

export interface LlmModelPresetOption {
  id: string;
  label: string;
}

@Component({
  selector: 'app-context-capacity',
  imports: [FormsModule, EditorMode],
  templateUrl: './context-capacity.html',
  styleUrl: './context-capacity.css',
})
export class ContextCapacityComponent {
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly modelName = input('Unknown model');
  /** When non-empty, replaces the static model label with a dropdown to switch presets. */
  readonly modelPresetOptions = input<LlmModelPresetOption[]>([]);
  readonly activeLlmModelId = input('');
  readonly activeLlmModelChange = output<string>();
  readonly usedPercentage = input(0);
  readonly compressionNotice = input('');
  readonly editorMode = model(true);
  readonly autoApplyMode = model(false);

  private static readonly circleRadius = 16;
  private static readonly circleCircumference = 2 * Math.PI * ContextCapacityComponent.circleRadius;
  private static readonly compactNumber = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  private static readonly fullNumber = new Intl.NumberFormat('en');

  protected readonly progressClass = computed(() => {
    const usedPercentage = this.usedPercentage();
    if (usedPercentage >= 95) return 'context-capacity--danger';
    if (usedPercentage >= 80) return 'context-capacity--warn';
    return 'context-capacity--healthy';
  });

  protected readonly dashOffset = computed(() => {
    const progress = Math.min(100, Math.max(0, this.usedPercentage()));
    return ContextCapacityComponent.circleCircumference * (1 - progress / 100);
  });

  protected readonly circleCircumference = ContextCapacityComponent.circleCircumference;

  protected readonly percentageLabel = computed(() => `${this.usedPercentage()}% used`);

  protected readonly tooltip = computed(() => (
    `${this.percentageLabel()} of ${this.formatFull(this.maxTokens())} tokens for ${this.modelName()}`
  ));

  protected formatCompact(value: number): string {
    return ContextCapacityComponent.compactNumber.format(Math.max(0, value));
  }

  protected formatFull(value: number): string {
    return ContextCapacityComponent.fullNumber.format(Math.max(0, value));
  }

  toggleAutoApply(): void {
    this.autoApplyMode.set(!this.autoApplyMode());
  }
}
