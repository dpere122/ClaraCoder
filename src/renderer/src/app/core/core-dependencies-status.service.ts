import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  DEPENDENCY_LABELS,
  findLlmModelLocation,
  findManagedLocalLlamaLocation,
  type AppConfig,
  type DependencyId,
  type DependencyInfo,
} from '@shared/index';
import { ElectronService } from './electron.service';

/**
 * Runtime pieces the app can't work without; the rest (LSP, TTS, STT) are optional extras.
 * Python isn't listed: it ships with the app.
 */
export const CORE_DEPENDENCY_IDS: readonly DependencyId[] = ['llama-server'];

/**
 * Whether the selected source needs the core dependencies: no model picked yet, or a managed
 * local llama-server model. LM Studio, OpenRouter and remote URLs run without them.
 */
export function coreDependenciesNeeded(config: AppConfig | null): boolean {
  const mid = config?.activeLlmModelId?.trim();
  if (!config || !mid || !findLlmModelLocation(config.llmProviders, mid)) {
    return true;
  }
  return findManagedLocalLlamaLocation(config) !== null;
}

/** Core dependencies not on disk yet, in {@link CORE_DEPENDENCY_IDS} order. */
export function missingCoreDependencies(deps: readonly DependencyInfo[]): DependencyId[] {
  return CORE_DEPENDENCY_IDS.filter((id) => deps.find((dep) => dep.id === id)?.state === 'missing');
}

/** Installed core dependencies that a reinstall would update, in {@link CORE_DEPENDENCY_IDS} order. */
export function outdatedCoreDependencies(deps: readonly DependencyInfo[]): DependencyId[] {
  return CORE_DEPENDENCY_IDS.filter((id) => {
    const dep = deps.find((d) => d.id === id);
    return dep?.state === 'installed' && !!dep.updateAvailable;
  });
}

/**
 * Tracks whether a core dependency (llama-server) still needs downloading or is behind the
 * build Clara installs, so the shell can flag its Dependencies entry points. Re-checks when
 * an install finishes and when the window regains focus (the user is back from the
 * Dependencies window, possibly after a delete).
 */
@Injectable({ providedIn: 'root' })
export class CoreDependenciesStatusService {
  private readonly electron = inject(ElectronService);

  readonly missing = signal<readonly DependencyId[]>([]);
  readonly hasMissing = computed(() => this.missing().length > 0);
  /** Tooltip / aria text naming what's missing, or '' when all core deps are installed. */
  readonly missingSummary = computed(() => {
    const labels = this.missing().map((id) => DEPENDENCY_LABELS[id]);
    return labels.length ? `Not downloaded: ${labels.join(', ')}` : '';
  });
  /** Installed core deps older than the version a reinstall would fetch. */
  readonly outdated = signal<readonly DependencyId[]>([]);
  /** Tooltip / aria text naming what's out of date, or '' when every install is current. */
  readonly outdatedSummary = computed(() => {
    const labels = this.outdated().map((id) => DEPENDENCY_LABELS[id]);
    return labels.length ? `Update available: ${labels.join(', ')}` : '';
  });

  private static readonly FOCUS_REFRESH_MIN_MS = 5_000;

  private inFlight: Promise<void> | null = null;
  private reloadQueued = false;
  private lastRefreshAt = 0;

  constructor() {
    if (!this.electron.isElectron) {
      return;
    }
    const offProgress = this.electron.onDepsProgress((event) => {
      if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') {
        void this.refresh();
      }
    });
    const onFocus = () => {
      if (Date.now() - this.lastRefreshAt >= CoreDependenciesStatusService.FOCUS_REFRESH_MIN_MS) {
        void this.refresh();
      }
    };
    window.addEventListener('focus', onFocus);
    inject(DestroyRef).onDestroy(() => {
      offProgress();
      window.removeEventListener('focus', onFocus);
    });
    void this.refresh();
  }

  /** A refresh asked for mid-load runs once more after it: that load may predate the change. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.reloadQueued = true;
      return this.inFlight;
    }
    this.inFlight = this.loadUntilCurrent().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async loadUntilCurrent(): Promise<void> {
    do {
      this.reloadQueued = false;
      await this.load();
    } while (this.reloadQueued);
  }

  private async load(): Promise<void> {
    this.lastRefreshAt = Date.now();
    try {
      const result = await this.electron.depsList();
      if (result.dependencies.length > 0) {
        this.missing.set(missingCoreDependencies(result.dependencies));
        this.outdated.set(outdatedCoreDependencies(result.dependencies));
      }
    } catch {
      /* keep the last known state */
    }
  }
}
