import { Component, ViewEncapsulation, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { lmStudioLoadOptions } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';
import { SettingsStore } from '../../settings/settings-store';
import {
  formatLmStudioTokens,
  lmStudioContextOptions,
  lmStudioSuggestedProfile,
  lmStudioThinkingOptions,
  lmStudioThinkingPatch,
  lmStudioThinkingValue,
} from './lm-studio-models';

/**
 * LM Studio's two kinds of setting. Load settings go to ``/api/v1/models/load`` and hold until the
 * model reloads; response settings go on each ``/v1/chat/completions`` request.
 */
@Component({
  selector: 'app-lm-studio-controls',
  imports: [FormsModule, LucideAngularModule, PillSelectComponent],
  templateUrl: './lm-studio-controls.html',
  encapsulation: ViewEncapsulation.None,
})
export class LmStudioControlsComponent {
  protected readonly s = inject(SettingsStore);

  protected readonly parallelOptions = [
    { id: '1', label: '1 at a time' },
    { id: '2', label: '2 at once' },
    { id: '4', label: '4 at once' },
    { id: '8', label: '8 at once' },
  ];
  protected readonly batchOptions = [
    { id: '256', label: '256' },
    { id: '512', label: '512' },
    { id: '1024', label: '1,024' },
    { id: '2048', label: '2,048' },
    { id: '4096', label: '4,096' },
  ];
  protected readonly idleOptions = [
    { id: '300', label: '5 minutes' },
    { id: '900', label: '15 minutes' },
    { id: '1800', label: '30 minutes' },
    { id: '3600', label: '1 hour' },
    { id: '14400', label: '4 hours' },
  ];
  protected readonly formatTokens = formatLmStudioTokens;
  protected readonly String = String;

  protected readonly card = computed(() => this.s.lmStudioChatCard());
  protected readonly connection = computed(() => this.s.selectedResolved());

  protected readonly contextOptions = computed(() => lmStudioContextOptions(this.card()?.max_context_length ?? 0));
  /** The size a load would really use, which the model's max can cut below the saved one. */
  protected readonly contextValue = computed(() =>
    String(lmStudioLoadOptions(this.s.lmStudioSettings(), this.card()?.max_context_length ?? 0).contextLength),
  );

  protected readonly thinkingOptions = computed(() => lmStudioThinkingOptions(this.card()));
  protected readonly thinkingValue = computed(() =>
    lmStudioThinkingValue(this.card(), this.connection()?.thinkingMode, this.connection()?.reasoningEffort),
  );

  protected readonly profileOptions = computed(() =>
    this.s.presetsFor('lmstudio').map((preset) => ({ id: preset.id, label: preset.label, title: preset.summary })),
  );
  /** A profile that fits this model better than the selected one, to offer. */
  protected readonly suggestedProfile = computed(() => {
    const suggested = lmStudioSuggestedProfile(this.card());
    if (!suggested || suggested === this.connection()?.optimizationPreset) {
      return null;
    }
    return this.profileOptions().find((p) => p.id === suggested) ?? null;
  });

  protected onThinkingChange(value: string): void {
    this.s.updateSelectedModel(lmStudioThinkingPatch(value));
  }

  protected onIntSetting(key: 'contextLength' | 'parallel' | 'evalBatchSize' | 'idleTtlSeconds', value: string): void {
    this.s.updateLmStudioSettings({ [key]: Number(value) });
  }
}
