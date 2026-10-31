import { Component, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  LLM_THINKING_MODE_OPTIONS,
  OPENROUTER_DEFAULT_BASE_URL,
  llmComposerEffortOptions,
  llmComposerEffortValue,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  unwrapSecret,
  type ChatTemplateReasoningCaps,
  type LlmProviderConfig,
} from '@shared/index';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';
import {
  OPENROUTER_MODEL_SORT_OPTIONS,
  filterOpenRouterModels,
  formatOpenRouterContext,
  formatOpenRouterPrice,
  maskOpenRouterApiKey,
  openRouterModelIsFree,
  type OpenRouterModelSort,
} from './openrouter-model-search';

/** Cards rendered per "Show more" step; the full tool-capable catalog runs to several hundred. */
const OPENROUTER_GRID_PAGE = 48;

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
  /** Scanned efforts only, as in the composer (which would revert a Default picked here). */
  private readonly scannedEffortOptions = computed(() => llmComposerEffortOptions(this.liveCaps()));
  protected readonly reasoningEffortOptions = computed(() => {
    const scanned = this.scannedEffortOptions();
    return scanned.length
      ? scanned
      : llmEffortSelectOptionsFromCaps(this.liveCaps(), this.s.selectedModel()?.optimizationPreset);
  });
  /** Effort the dropdown shows: the composer's pick when the model was scanned, else the saved one. */
  protected readonly reasoningEffortValue = computed(() => {
    const saved = this.s.selectedResolved()?.reasoningEffort || '';
    const scanned = this.scannedEffortOptions();
    return scanned.length ? llmComposerEffortValue(scanned, saved) : saved;
  });
  protected readonly builtinEmbeddingsOptions = [{ id: '', label: 'Built-in CPU embeddings' }];

  protected readonly openRouterDefaultBaseUrl = OPENROUTER_DEFAULT_BASE_URL;
  /** Connection fields are drafted here and only reach the config on Save. */
  protected readonly openRouterEditing = signal(false);
  protected readonly openRouterKeyDraft = signal('');
  protected readonly openRouterBaseUrlDraft = signal('');
  protected readonly openRouterSaving = signal(false);
  protected readonly openRouterKeyMask = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'openrouter' ? maskOpenRouterApiKey(unwrapSecret(p.apiKey)) : '';
  });

  protected readonly openRouterSortOptions = OPENROUTER_MODEL_SORT_OPTIONS;
  protected readonly openRouterQuery = signal('');
  protected readonly openRouterSort = signal<OpenRouterModelSort>('newest');
  protected readonly openRouterFreeOnly = signal(false);
  protected readonly openRouterReasoningOnly = signal(false);
  private readonly openRouterLimit = signal(OPENROUTER_GRID_PAGE);
  protected readonly openRouterResults = computed(() =>
    filterOpenRouterModels(this.s.openRouterModels(), {
      query: this.openRouterQuery(),
      sort: this.openRouterSort(),
      freeOnly: this.openRouterFreeOnly(),
      reasoningOnly: this.openRouterReasoningOnly(),
    }),
  );
  protected readonly openRouterVisible = computed(() => this.openRouterResults().slice(0, this.openRouterLimit()));
  /** Catalog row for the saved model id, if the catalog lists it. */
  protected readonly openRouterCurrent = computed(() => {
    const id = this.s.selectedModel()?.model ?? '';
    return id ? (this.s.openRouterModels().find((m) => m.id === id) ?? null) : null;
  });
  /** A typed id that looks like ``vendor/model`` but is not in the catalog can still be used as-is. */
  protected readonly openRouterCustomId = computed(() => {
    const q = this.openRouterQuery().trim();
    if (!q.includes('/') || /\s/.test(q)) {
      return '';
    }
    return this.s.openRouterModels().some((m) => m.id === q) ? '' : q;
  });
  private readonly openRouterSourceId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'openrouter' ? p.id : null;
  });

  protected readonly formatContext = formatOpenRouterContext;
  protected readonly formatPrice = formatOpenRouterPrice;
  protected readonly isFree = openRouterModelIsFree;

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

  protected beginOpenRouterEdit(provider: LlmProviderConfig): void {
    this.openRouterKeyDraft.set(unwrapSecret(provider.apiKey));
    this.openRouterBaseUrlDraft.set(provider.baseUrl);
    this.openRouterEditing.set(true);
  }

  protected cancelOpenRouterEdit(): void {
    this.openRouterEditing.set(false);
    this.openRouterKeyDraft.set('');
    this.openRouterBaseUrlDraft.set('');
  }

  protected async saveOpenRouterEdit(): Promise<void> {
    if (this.openRouterSaving()) {
      return;
    }
    this.openRouterSaving.set(true);
    try {
      await this.s.saveOpenRouterConnection({
        apiKey: this.openRouterKeyDraft(),
        baseUrl: this.openRouterBaseUrlDraft(),
      });
      this.cancelOpenRouterEdit();
    } finally {
      this.openRouterSaving.set(false);
    }
  }

  protected onOpenRouterQueryChange(query: string): void {
    this.openRouterQuery.set(query);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected toggleOpenRouterFreeOnly(): void {
    this.openRouterFreeOnly.update((on) => !on);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected toggleOpenRouterReasoningOnly(): void {
    this.openRouterReasoningOnly.update((on) => !on);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected showMoreOpenRouterModels(): void {
    this.openRouterLimit.update((n) => n + OPENROUTER_GRID_PAGE);
  }

  constructor() {
    effect(() => {
      const id = this.s.selectedModel()?.id;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });
    // Opening the OpenRouter card loads the catalog (it lists without a key) and drops any
    // half-edited connection left from an earlier visit.
    effect(() => {
      const sourceId = this.openRouterSourceId();
      untracked(() => {
        this.cancelOpenRouterEdit();
        if (sourceId && !this.s.openRouterModels().length && !this.s.openRouterModelsListInFlight()) {
          void this.s.refreshOpenRouterModels();
        }
      });
    });
  }
}
