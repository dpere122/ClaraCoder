import { Injectable, computed, inject, signal } from '@angular/core';
import type { AnthropicCatalogModel, AnthropicStatus } from '@shared/index';
import { ElectronService } from './electron.service';

/**
 * Claude source state for this window: key status (never the key), the model catalog, and the
 * model pick. Main owns the key and the catalog; this only mirrors what it reports.
 */
@Injectable({ providedIn: 'root' })
export class AnthropicService {
  private readonly electron = inject(ElectronService);

  readonly status = signal<AnthropicStatus | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  /** Last action error (bad key, network, model pick). Cleared by the next success. */
  readonly error = signal('');
  readonly models = computed<readonly AnthropicCatalogModel[]>(() => this.status()?.models ?? []);
  readonly configured = computed(() => this.status()?.configured === true);
  private loadGen = 0;

  /** Load the status once per window; later calls reuse it unless ``refresh`` is set. */
  async ensureLoaded(): Promise<void> {
    if (!this.status() && !this.loading()) {
      await this.refresh(false);
    }
  }

  async refresh(refresh = true): Promise<void> {
    const gen = ++this.loadGen;
    this.loading.set(true);
    try {
      const res = await this.electron.anthropicStatus({ refresh });
      if (gen !== this.loadGen) {
        return;
      }
      this.status.set(res.status);
      this.error.set(res.ok ? '' : res.error);
    } catch (err) {
      if (gen === this.loadGen) {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (gen === this.loadGen) {
        this.loading.set(false);
      }
    }
  }

  /** Send the key to main (checked, encrypted, stored there). True when it was accepted. */
  async saveKey(apiKey: string): Promise<boolean> {
    this.saving.set(true);
    this.loadGen += 1;
    try {
      const res = await this.electron.anthropicSetApiKey({ apiKey });
      this.status.set(res.status);
      this.error.set(res.ok ? '' : res.error);
      return res.status.configured;
    } finally {
      this.saving.set(false);
      this.loading.set(false);
    }
  }

  async clearKey(): Promise<void> {
    this.saving.set(true);
    this.loadGen += 1;
    try {
      const res = await this.electron.anthropicClearApiKey();
      this.status.set(res.status);
      this.error.set('');
    } finally {
      this.saving.set(false);
      this.loading.set(false);
    }
  }

  /** Point the Claude source at ``modelId``; main saves it and resyncs the backend. */
  async setModel(modelId: string): Promise<boolean> {
    const res = await this.electron.anthropicSetModel({ modelId });
    this.error.set(res.ok ? '' : res.error);
    return res.ok;
  }
}
