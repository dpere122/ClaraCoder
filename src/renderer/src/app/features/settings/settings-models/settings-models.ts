import { Component, ViewEncapsulation, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  LLM_THINKING_MODE_OPTIONS,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  type ChatTemplateReasoningCaps,
} from '@shared/index';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-models',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent],
  templateUrl: './settings-models.html',
  styleUrl: './settings-models.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModels {
  protected readonly s = inject(SettingsStore);
  private readonly electron = inject(ElectronService);
  private readonly capsByModel = toSignal(this.electron.chatTemplateReasoning$, {
    initialValue: {} as Readonly<Record<string, ChatTemplateReasoningCaps>>,
  });
  protected readonly thinkingModeOptions = LLM_THINKING_MODE_OPTIONS;
  private readonly liveCaps = computed(() => {
    const id = this.s.selectedModel()?.id;
    return id ? this.capsByModel()[id] : undefined;
  });
  protected readonly thinkingVisible = computed(() =>
    llmThinkingControlVisible(this.s.selectedModel()?.optimizationPreset, this.liveCaps()),
  );
  protected readonly effortVisible = computed(() =>
    llmEffortControlVisible(this.s.selectedModel()?.optimizationPreset, this.liveCaps()),
  );
  protected readonly reasoningEffortOptions = computed(() =>
    llmEffortSelectOptionsFromCaps(this.liveCaps(), this.s.selectedModel()?.optimizationPreset),
  );

  constructor() {
    effect(() => {
      const id = this.s.selectedModel()?.id;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });
  }
}
