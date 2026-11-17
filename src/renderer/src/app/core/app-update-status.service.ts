import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { findAvailableAppUpdate, type AppReleaseSummary } from '@shared/app-updater';
import { ElectronService } from './electron.service';

/**
 * Tracks whether a newer installable Clara release exists, so the title-bar version label can
 * flag it. Checks on {@link start} and then every 10 minutes. A failed check keeps the last known
 * state.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateStatusService {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  /** Newest release the Updates window would offer as an update, or null. */
  readonly latestUpdate = signal<AppReleaseSummary | null>(null);
  readonly updateAvailable = computed(() => this.latestUpdate() !== null);
  /** Tooltip / aria text for the version button. */
  readonly tooltip = computed(() => {
    const update = this.latestUpdate();
    return update ? `Update available: v${update.version} — open Updates` : 'Open Updates';
  });

  static readonly REFRESH_INTERVAL_MS = 10 * 60_000;

  private started = false;
  private inFlight: Promise<void> | null = null;

  /** Runs the first check and re-checks every 10 minutes; later calls do nothing. */
  start(): void {
    if (this.started || !this.electron.isElectron) {
      return;
    }
    this.started = true;
    const timer = setInterval(() => void this.refresh(), AppUpdateStatusService.REFRESH_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
    void this.refresh();
  }

  /** Re-reads the release list; joins a check that is already running. */
  refresh(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.load().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async load(): Promise<void> {
    try {
      const result = await this.electron.updaterListReleases(false);
      if (!result?.ok) {
        return;
      }
      const version = result.currentVersion || (await this.electron.appVersion());
      this.latestUpdate.set(findAvailableAppUpdate(result.releases, version));
    } catch {
      /* keep the last known state */
    }
  }
}
