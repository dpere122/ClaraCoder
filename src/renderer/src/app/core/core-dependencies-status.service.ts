import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { DEPENDENCY_LABELS, type DependencyId, type DependencyInfo } from '@shared/index';
import { ElectronService } from './electron.service';

/**
 * Runtime pieces the app can't work without; the rest (LSP, TTS, STT) are optional extras.
 * Python isn't listed: it ships with the app.
 */
export const CORE_DEPENDENCY_IDS: readonly DependencyId[] = ['llama-server'];

/** Core dependencies not on disk yet, in {@link CORE_DEPENDENCY_IDS} order. */
export function missingCoreDependencies(deps: readonly DependencyInfo[]): DependencyId[] {
  return CORE_DEPENDENCY_IDS.filter((id) => deps.find((dep) => dep.id === id)?.state === 'missing');
}

/**
 * Tracks whether a core dependency (llama-server) still needs downloading, so the shell can
 * flag its Dependencies entry points. Re-checks when an install finishes and when the window
 * regains focus (the user is back from the Dependencies window, possibly after a delete).
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

  private static readonly FOCUS_REFRESH_MIN_MS = 5_000;

  private inFlight: Promise<void> | null = null;
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

  refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    this.lastRefreshAt = Date.now();
    try {
      const result = await this.electron.depsList();
      if (result.dependencies.length > 0) {
        this.missing.set(missingCoreDependencies(result.dependencies));
      }
    } catch {
      /* keep the last known state */
    }
  }
}
