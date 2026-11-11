import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { LucideAngularModule } from 'lucide-angular';
import type { Subscription } from 'rxjs';
import type { AppConfig } from '@shared/index';
import {
  appReleaseAction,
  compareAppVersions,
  isPrereleaseVersion,
  visibleAppReleases,
  type AppReleaseAction,
  type AppReleaseSummary,
  type AppUpdateState,
} from '@shared/app-updater';
import { ElectronService } from '../../../core/electron.service';
import { applyAppFontOverrides } from '../../../core/theme/app-font-overrides';
import { renderReleaseNotes } from '../release-notes';

const ACTION_LABELS: Record<AppReleaseAction, string> = {
  update: 'Update',
  downgrade: 'Downgrade',
  reinstall: 'Reinstall',
};

export function formatReleaseDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Same version string, or equal semver (`0.2.0` vs `0.2.0+build`). */
function sameVersion(a: string, b: string): boolean {
  return a === b || compareAppVersions(a, b) === 0;
}

@Component({
  selector: 'app-updater',
  imports: [LucideAngularModule],
  templateUrl: './updater.html',
  styleUrl: './updater.css',
})
export class Updater implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly currentVersion = signal('');
  protected readonly releases = signal<AppReleaseSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  /** Stable releases are the default; pre-releases only when opted in. */
  protected readonly showBeta = signal(false);
  protected readonly selectedVersion = signal<string | null>(null);
  protected readonly updateState = signal<AppUpdateState | null>(null);
  protected readonly actionError = signal('');

  protected readonly visibleReleases = computed(() => visibleAppReleases(this.releases(), this.showBeta()));
  protected readonly selected = computed(
    () => this.visibleReleases().find((r) => r.version === this.selectedVersion()) ?? null,
  );
  protected readonly selectedAction = computed<AppReleaseAction | null>(() => {
    const r = this.selected();
    const current = this.currentVersion();
    return r && current ? appReleaseAction(current, r.version) : null;
  });
  protected readonly notesHtml = computed<SafeHtml | null>(() => {
    const notes = this.selected()?.notes.trim();
    return notes ? this.sanitizer.bypassSecurityTrustHtml(renderReleaseNotes(notes)) : null;
  });
  protected readonly busy = computed(() => {
    const phase = this.updateState()?.phase;
    return phase === 'downloading' || phase === 'verifying';
  });
  /** Progress / error belongs to the selected release. */
  protected readonly selectedState = computed(() => {
    const s = this.updateState();
    const r = this.selected();
    return s && r && s.version === r.version ? s : null;
  });
  protected readonly progressPercent = computed(() => {
    const s = this.updateState();
    return s && s.totalBytes > 0 ? Math.min(100, Math.round((s.receivedBytes / s.totalBytes) * 100)) : 0;
  });
  protected readonly readyState = computed(() => {
    const s = this.updateState();
    return s?.phase === 'ready' ? s : null;
  });

  protected readonly actionLabels = ACTION_LABELS;
  protected readonly formatDate = formatReleaseDate;
  protected readonly formatMb = formatMegabytes;

  private configSub?: Subscription;
  private offState?: () => void;

  constructor() {
    // Keep a valid selection when the beta toggle hides the selected release.
    effect(() => {
      const visible = this.visibleReleases();
      const sel = this.selectedVersion();
      if (visible.length && (!sel || !visible.some((r) => r.version === sel))) {
        const current = this.currentVersion();
        this.selectedVersion.set((visible.find((r) => sameVersion(r.version, current)) ?? visible[0]!).version);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    const cfg = await this.electron.loadConfig();
    applyAppFontOverrides(cfg);
    this.configSub = this.electron.config$.subscribe((c: AppConfig) => applyAppFontOverrides(c));
    this.offState = this.electron.onUpdaterState((s) => this.updateState.set(s));
    this.updateState.set(await this.electron.updaterGetState());
    await this.refresh(false);
  }

  ngOnDestroy(): void {
    this.configSub?.unsubscribe();
    this.offState?.();
  }

  protected async refresh(force = true): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.electron.updaterListReleases(force);
      if (result.currentVersion && !this.currentVersion()) {
        this.currentVersion.set(result.currentVersion);
        // Running a beta: show betas so the current version is in the list.
        if (isPrereleaseVersion(result.currentVersion)) this.showBeta.set(true);
      }
      this.releases.set(result.releases);
      this.listError.set(result.ok ? '' : (result.error ?? 'Could not load releases'));
    } finally {
      this.loading.set(false);
    }
  }

  protected isCurrent(r: AppReleaseSummary): boolean {
    return !!this.currentVersion() && sameVersion(r.version, this.currentVersion());
  }

  protected select(version: string): void {
    this.selectedVersion.set(version);
    this.actionError.set('');
  }

  protected onListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = this.visibleReleases();
    const i = list.findIndex((r) => r.version === this.selectedVersion());
    const next = list[Math.max(0, Math.min(list.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    this.select(next.version);
    queueMicrotask(() =>
      (document.querySelector(`[data-version="${CSS.escape(next.version)}"]`) as HTMLElement | null)?.focus(),
    );
  }

  protected async runAction(r: AppReleaseSummary): Promise<void> {
    this.actionError.set('');
    const result = await this.electron.updaterDownload(r.version);
    if (!result.ok && result.error && result.error !== 'Download cancelled') {
      this.actionError.set(result.error);
    }
  }

  protected cancelDownload(): void {
    void this.electron.updaterCancel();
  }

  protected async restartAndInstall(): Promise<void> {
    const result = await this.electron.updaterInstallNow();
    if (!result.ok) this.actionError.set(result.error ?? 'Could not start the installer');
  }

  protected async restartLater(): Promise<void> {
    const result = await this.electron.updaterInstallOnQuit();
    if (!result.ok) this.actionError.set(result.error ?? 'Could not schedule the install');
  }

  protected closeWindow(): void {
    this.electron.closeUpdaterWindow();
  }
}
