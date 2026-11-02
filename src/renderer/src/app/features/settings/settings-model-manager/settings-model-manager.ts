import { Component, DestroyRef, ViewEncapsulation, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import type {
  HuggingFaceModelDetails,
  HuggingFaceModelSearchItem,
  ModelManagerFileEntry,
} from '@shared/index';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';
import {
  FEATURED_HF_MODELS,
  type FeaturedHfModel,
  formatHfContext,
  formatHfCount,
  formatHfDate,
  formatHfParams,
  hubFolderRepoId,
  maskHfToken,
  splitHfRepoId,
} from './hf-models';

/** One row of the model list: a downloaded model, a featured repo, or a Hub search result. */
type LocalRow = { kind: 'local'; key: string; provider: string; name: string; repoId: string | null; model: ModelManagerFileEntry };
type FeaturedRow = { kind: 'featured'; key: string; provider: string; name: string; repoId: string; featured: FeaturedHfModel };
type ResultRow = { kind: 'result'; key: string; provider: string; name: string; repoId: string; item: HuggingFaceModelSearchItem };
type ModelRow = LocalRow | FeaturedRow | ResultRow;

/** Typing waits this long before querying the Hub; local and featured rows filter instantly. */
const HUB_SEARCH_DEBOUNCE_MS = 450;

@Component({
  selector: 'app-settings-model-manager',
  imports: [FormsModule, LucideAngularModule, NgTemplateOutlet, PillSelectComponent],
  templateUrl: './settings-model-manager.html',
  styleUrl: './settings-model-manager.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModelManager {
  protected readonly s = inject(SettingsStore);

  protected readonly formatCount = formatHfCount;
  protected readonly formatDate = formatHfDate;
  protected readonly formatParams = formatHfParams;
  protected readonly formatContext = formatHfContext;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearSearchTimer());
  }

  private readonly filter = computed(() => this.s.modelManagerHfQuery().trim().toLowerCase());

  private matches(...fields: string[]): boolean {
    const f = this.filter();
    return !f || fields.some((v) => v.toLowerCase().includes(f));
  }

  /** Downloaded models, filtered by the search text. */
  protected readonly localRows = computed<LocalRow[]>(() =>
    this.s
      .modelManagerCustomModels()
      .map((model): LocalRow => {
        const repoId = model.entryKind === 'hubRepo' ? hubFolderRepoId(model.fileName) : null;
        const { provider, name } = repoId ? splitHfRepoId(repoId) : { provider: '', name: model.fileName };
        return { kind: 'local', key: `local:${model.absolutePath}`, provider, name, repoId, model };
      })
      .filter((row) => this.matches(row.provider, row.name, row.model.fileName)),
  );

  /** Hub repos already on disk, so featured and result rows can say so. */
  protected readonly localRepoIds = computed(
    () => new Set(this.localRows().flatMap((row) => (row.repoId ? [row.repoId.toLowerCase()] : []))),
  );

  /** Featured repos until a Hub search returns results. */
  protected readonly featuredRows = computed<FeaturedRow[]>(() => {
    if (this.s.modelManagerHfRawResults().length) {
      return [];
    }
    return FEATURED_HF_MODELS.map((featured): FeaturedRow => {
      const { provider, name } = splitHfRepoId(featured.id);
      return { kind: 'featured', key: `hf:${featured.id}`, provider, name, repoId: featured.id, featured };
    }).filter((row) => this.matches(row.provider, row.name, row.featured.maker));
  });

  protected readonly resultRows = computed<ResultRow[]>(() =>
    this.s.modelManagerHfResults().map((item): ResultRow => {
      const { provider, name } = splitHfRepoId(item.id);
      return { kind: 'result', key: `hf:${item.id}`, provider, name, repoId: item.id, item };
    }),
  );

  protected readonly selectedKey = computed(() => {
    const sel = this.s.modelManagerSelection();
    return !sel ? null : sel.kind === 'hf' ? `hf:${sel.id}` : `local:${sel.path}`;
  });

  /** The local model behind the selection; null when the selection is a Hub repo or was removed. */
  protected readonly selectedLocal = computed(() => {
    const sel = this.s.modelManagerSelection();
    if (sel?.kind !== 'local') {
      return null;
    }
    const model = this.s.modelManagerCustomModels().find((m) => m.absolutePath === sel.path);
    if (!model) {
      return null;
    }
    const repoId = model.entryKind === 'hubRepo' ? hubFolderRepoId(model.fileName) : null;
    return { model, repoId, ...(repoId ? splitHfRepoId(repoId) : { provider: '', name: model.fileName }) };
  });

  protected readonly selectedRepoId = computed(() => {
    const sel = this.s.modelManagerSelection();
    return sel?.kind === 'hf' ? sel.id : (this.selectedLocal()?.repoId ?? null);
  });

  protected readonly selectedRepo = computed(() => {
    const id = this.selectedRepoId();
    return id ? { id, ...splitHfRepoId(id) } : null;
  });

  protected readonly selectedFeatured = computed(
    () => FEATURED_HF_MODELS.find((f) => f.id === this.selectedRepoId()) ?? null,
  );

  protected readonly selectedDetails = computed<HuggingFaceModelDetails | null>(() => {
    const id = this.selectedRepoId();
    const res = id ? this.s.modelManagerHfDetailsById()[id] : undefined;
    return res?.ok ? res.details : null;
  });

  protected readonly selectedDetailsError = computed(() => {
    const id = this.selectedRepoId();
    const res = id ? this.s.modelManagerHfDetailsById()[id] : undefined;
    return res && !res.ok ? res.error : '';
  });

  protected readonly selectedDetailsBusy = computed(() => {
    const id = this.selectedRepoId();
    return !!id && !!this.s.modelManagerHfDetailsBusyById()[id];
  });

  protected select(row: ModelRow): void {
    if (row.kind === 'local') {
      this.s.selectLocalModel(row.model, row.repoId);
    } else {
      this.s.selectHfModel(row.repoId);
    }
  }

  /** Arrow keys move the selection through the list. */
  protected onListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const rows = [...this.localRows(), ...this.featuredRows(), ...this.resultRows()];
    if (!rows.length) {
      return;
    }
    event.preventDefault();
    const at = rows.findIndex((r) => r.key === this.selectedKey());
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    const row = rows[next]!;
    this.select(row);
    const list = event.currentTarget as HTMLElement;
    queueMicrotask(() => list.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(row.key)}"]`)?.focus());
  }

  protected onQueryChange(value: string): void {
    this.s.onModelManagerHfQueryChange(value);
    this.clearSearchTimer();
    if (!value.trim()) {
      void this.s.searchHuggingFaceModels(0);
      return;
    }
    this.searchTimer = setTimeout(() => void this.s.searchHuggingFaceModels(0), HUB_SEARCH_DEBOUNCE_MS);
  }

  protected searchNow(): void {
    this.clearSearchTimer();
    void this.s.searchHuggingFaceModels(0);
  }

  private clearSearchTimer(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  /** Avatar fallback: first letter of the owner name. */
  protected initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
  }

  // Token: read-only masked view with Edit, then a Save/Cancel form (same flow as the OpenRouter key).
  protected readonly tokenMask = computed(() => maskHfToken(this.s.modelManagerHfToken()));
  protected readonly tokenEditing = signal(false);
  protected readonly tokenDraft = signal('');
  protected readonly tokenSaving = signal(false);

  protected beginTokenEdit(): void {
    this.tokenDraft.set('');
    this.tokenEditing.set(true);
  }

  protected cancelTokenEdit(): void {
    this.tokenEditing.set(false);
    this.tokenDraft.set('');
  }

  protected async saveToken(): Promise<void> {
    if (this.tokenSaving() || !this.tokenDraft().trim()) {
      return;
    }
    this.tokenSaving.set(true);
    try {
      await this.s.saveHfToken(this.tokenDraft());
      this.cancelTokenEdit();
    } finally {
      this.tokenSaving.set(false);
    }
  }

  protected async removeToken(): Promise<void> {
    if (this.tokenSaving()) {
      return;
    }
    this.tokenSaving.set(true);
    try {
      await this.s.saveHfToken('');
    } finally {
      this.tokenSaving.set(false);
    }
  }

  protected hfCountOptions(values: readonly number[], allowMillions: boolean): { id: string; label: string }[] {
    return values.map((opt) => ({
      id: String(opt),
      label:
        opt === 0
          ? 'Any'
          : allowMillions && opt >= 1_000_000
            ? `${opt / 1_000_000}M+`
            : opt >= 1_000
              ? `${opt / 1_000}k+`
              : `${opt}+`,
    }));
  }
}
