import { Component, ViewEncapsulation, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  LLM_THINKING_MODE_OPTIONS,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  type ChatTemplateReasoningCaps,
  type LlmProviderConfig,
} from '@shared/index';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-models',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent, PillSelectComponent],
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
  protected readonly builtinEmbeddingsOptions = [{ id: '', label: 'Built-in CPU embeddings' }];

  protected lmStudioChatOptions(): { id: string; label: string }[] {
    const current = this.s.selectedModel()?.model ?? '';
    const rows = this.s.lmStudioMainModelOptions().map((opt) => ({
      id: opt.id,
      label: `${opt.id} — ${opt.state}`,
    }));
    if (current && !rows.some((row) => row.id === current)) {
      rows.unshift({ id: current, label: `${current} (current)` });
    }
    return rows;
  }

  protected managedModelOptions(): { id: string; label: string }[] {
    const rows = this.s.managedInventoryModels().map((model) => ({
      id: this.s.managedInventoryOptionValue(model),
      label: `${model.fileName} · ${this.s.formatModelBytes(model.sizeBytes)} · ${this.s.managedInventoryFamilyLabel(model)}`,
    }));
    const picked = this.s.managedPickerValue();
    if (picked.startsWith('hf:') && !rows.some((row) => row.id === picked)) {
      rows.push({ id: picked, label: `${picked.slice(3)} (HF)` });
    }
    return [{ id: '', label: 'Select a model' }, ...rows];
  }

  protected labeledIds(values: readonly string[], emptyLabel?: string): { id: string; label: string }[] {
    const rows = values.map((value) => ({ id: value, label: value }));
    return emptyLabel ? [{ id: '', label: emptyLabel }, ...rows] : rows;
  }

  protected presetOptions(provider: LlmProviderConfig['provider']): { id: string; label: string; title: string }[] {
    return this.s.presetsFor(provider).map((preset) => ({
      id: preset.id,
      label: preset.label,
      title: preset.summary,
    }));
  }

  constructor() {
    effect(() => {
      const id = this.s.selectedModel()?.id;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });
  }
}
