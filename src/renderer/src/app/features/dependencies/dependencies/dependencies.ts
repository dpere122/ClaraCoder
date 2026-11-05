import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  effect,
  untracked,
  viewChildren,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { ThemedConfirmDialogComponent } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { dependencyDeletePrompt } from '../../../shared/themed-confirm-dialog/format-delete-prompt';
import { nextSpeedSample, progressView, type ProgressView, type SpeedSample } from './dependency-progress';
import type {
  AppConfig,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
  DependencySource,
  LlamaServerVariant,
} from '@shared/index';
import {
  DEFAULT_WHISPER_MODEL,
  DEPENDENCY_SOURCES,
  LLAMA_SERVER_VARIANTS,
  LLAMA_SERVER_VARIANT_LABELS,
  WHISPER_MODEL_OPTIONS,
  WHISPER_SIZE_REPOS,
  dependencyComponents,
  whisperModelSource,
} from '@shared/index';
import { applyAppFontOverrides } from '../../../core/theme/app-font-overrides';
import { ElectronService } from '../../../core/electron.service';

interface LogEntry {
  ts: number;
  phase: string;
  message: string;
}

const LOG_MAX_LINES = 1000;
const LLAMA_SERVER_ID = 'llama-server';
const KOKORO_ID = 'kokoro';
const WHISPER_ID = 'whisper';

/** Row status shown to the user; `partial` = Whisper weights on disk but its packages missing. */
export type DependencyDisplayState = DependencyInfo['state'] | 'partial';

type InstallAction = 'download' | 'reinstall';

type TutorialLlamaState = 'checking' | 'missing' | 'installing' | 'success' | 'installed' | 'error' | 'cancelled';
type TutorialLlamaOutcome = 'success' | 'error' | 'cancelled' | null;

interface DependencyListRefresh {
  /** A newer request superseded this response, so it must not be used for verification. */
  superseded: boolean;
  /** Null for failed/fallback status queries or a response without llama-server. */
  dependencies: DependencyInfo[] | null;
}

/** Outcome shown on the row itself (replaces the old window-wide footer message). */
export interface RowMessage {
  tone: 'ok' | 'info' | 'error';
  text: string;
}

/** Success/info notes fade after this long; errors stay until the next action. */
const ROW_MESSAGE_MS = 6000;

/** Phases during which an install is still running. */
const RUNNING_PHASES = new Set(['queued', 'downloading', 'extracting', 'installing', 'finishing']);

interface DependencyGroupDef {
  id: string;
  label: string;
  ids: readonly DependencyId[];
  /** Whole group can't be downloaded yet; shown once on the group header. */
  comingSoon?: boolean;
}

export interface DependencyGroup {
  id: string;
  label: string;
  comingSoon: boolean;
  deps: DependencyInfo[];
}

const DEPENDENCY_GROUPS: readonly DependencyGroupDef[] = [
  { id: 'required', label: 'Required', ids: ['llama-server'] },
  { id: 'lsp', label: 'Language servers', ids: ['java-lsp', 'gdls'] },
  { id: 'voice', label: 'Voice', ids: ['kokoro', 'whisper'], comingSoon: true },
];

/** Bucket the reported list into display groups; ids no group claims land in "Other". */
export function groupDependencies(deps: readonly DependencyInfo[]): DependencyGroup[] {
  const claimed = new Set<string>(DEPENDENCY_GROUPS.flatMap((g) => g.ids));
  const out: DependencyGroup[] = DEPENDENCY_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    comingSoon: g.comingSoon ?? false,
    deps: g.ids.map((id) => deps.find((d) => d.id === id)).filter((d): d is DependencyInfo => !!d),
  }));
  const other = deps.filter((d) => !claimed.has(d.id));
  if (other.length) out.push({ id: 'other', label: 'Other', comingSoon: false, deps: other });
  return out.filter((g) => g.deps.length > 0);
}

/** Variant key the llama-server provider reports as a `variant: <key>` component. */
export function installedLlamaVariant(dep: Pick<DependencyInfo, 'state' | 'components'>): LlamaServerVariant | null {
  if (dep.state !== 'installed') return null;
  for (const c of dep.components ?? []) {
    const m = /^variant:\s*(\S+)$/.exec(c.trim());
    if (m && (LLAMA_SERVER_VARIANTS as readonly string[]).includes(m[1]!)) return m[1] as LlamaServerVariant;
  }
  return null;
}

@Component({
  selector: 'app-dependencies',
  imports: [NgxSpinnerComponent, PillSelectComponent, ThemedConfirmDialogComponent],
  templateUrl: './dependencies.html',
  styleUrl: './dependencies.css',
})
export class Dependencies implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly themedConfirm = inject(ThemedConfirmDialogService);

  protected readonly listSpinnerName = 'deps-list-spinner';
  protected readonly listSpinnerType = 'ball-scale-multiple';

  protected readonly dependencies = signal<DependencyInfo[]>([]);
  protected readonly listLoading = signal(true);
  /** Spinner only before the first list arrives; later refreshes keep rows (and their messages) on screen. */
  protected readonly firstLoad = computed(() => this.listLoading() && this.dependencies().length === 0);
  /** List-level problems only (status query failed, fallback catalog); per-item results use rowMessages. */
  protected readonly statusMessage = signal('');
  protected readonly rowMessages = signal<Partial<Record<DependencyId, RowMessage>>>({});
  private readonly rowMessageTimers = new Map<DependencyId, ReturnType<typeof setTimeout>>();
  /** Running download rate per dependency, for the speed / time-left readout. */
  private readonly speedById = signal<Partial<Record<DependencyId, SpeedSample>>>({});
  /** Installs the user cancelled that are still cleaning up. */
  protected readonly cancellingIds = signal<Set<DependencyId>>(new Set());
  protected readonly busyIds = signal<Set<DependencyId>>(new Set());
  /** Local IPC actions remain busy until their result and subsequent status refresh finish. */
  private readonly pendingActionIds = signal<Set<DependencyId>>(new Set());
  private readonly listStatusTrusted = signal(false);
  private readonly llamaTutorialOutcome = signal<TutorialLlamaOutcome>(null);
  private listRefreshVersion = 0;
  private latestListRefresh: Promise<DependencyListRefresh> | null = null;
  private supersedeListRefresh: (() => void) | null = null;
  protected readonly progressById = signal<Partial<Record<DependencyId, DependencyProgressEvent>>>({});
  protected readonly logById = signal<Partial<Record<DependencyId, LogEntry[]>>>({});
  protected readonly variantById = signal<Partial<Record<DependencyId, LlamaServerVariant>>>({});
  protected readonly whisperSizeById = signal<Partial<Record<DependencyId, string>>>({});
  /** Rows whose Details section (installs, location, sources) is open. */
  protected readonly expandedDetails = signal<Set<DependencyId>>(new Set());

  protected readonly groups = computed(() => groupDependencies(this.dependencies()));
  protected readonly summary = computed(() => {
    const deps = this.dependencies();
    return {
      installed: deps.filter((d) => d.state === 'installed').length,
      total: deps.length,
      issues: deps.filter((d) => d.state === 'error' || this.displayState(d) === 'partial').length,
    };
  });

  /**
   * When set, the window switches from the full list to a focused view showing
   * only this dependency's card plus a live terminal log. Success/cancellation return to the list.
   */
  protected readonly activeId = signal<DependencyId | null>(null);
  /**
   * Set when the focused install failed: the view stays open with the log and error so the
   * output isn't lost, until the user goes back to the list or retries.
   */
  protected readonly failedId = signal<DependencyId | null>(null);
  /** Last install action per dependency, so Retry repeats a download vs. a reinstall. */
  private readonly lastAction = new Map<DependencyId, InstallAction>();

  /** DOM contract for the tutorial. A progress `done` is never an install result. */
  protected readonly tutorialLlamaBusy = computed(() => this.isBusy(LLAMA_SERVER_ID));
  /** Known operations plus unknown/checking status; skipping must not close or cancel downloads. */
  protected readonly tutorialDependenciesBusy = computed(() =>
    this.listLoading() ||
    !this.listStatusTrusted() ||
    this.pendingActionIds().size > 0 ||
    this.busyIds().size > 0 ||
    this.cancellingIds().size > 0 ||
    this.dependencies().some((dep) => dep.state === 'updating'),
  );
  protected readonly tutorialLlamaState = computed<TutorialLlamaState>(() => {
    const outcome = this.llamaTutorialOutcome();
    if (outcome === 'error' || outcome === 'cancelled') return outcome;
    if (this.tutorialLlamaBusy()) return 'installing';
    if (this.listLoading()) return 'checking';
    if (!this.listStatusTrusted()) return 'error';
    const dep = this.dependencies().find((item) => item.id === LLAMA_SERVER_ID);
    if (!dep || dep.state === 'error') return 'error';
    if (dep.state === 'installed') return outcome === 'success' ? 'success' : 'installed';
    if (dep.state === 'updating') return 'installing';
    return dep.state === 'missing' ? 'missing' : 'error';
  });
  /** The real card is replaced during focused views; keep a hidden state target when it is absent. */
  protected readonly tutorialLlamaFallback = computed(() => {
    const active = this.activeDep();
    if (active) return !this.isLlamaServer(active);
    return this.firstLoad() || !this.dependencies().some((dep) => dep.id === LLAMA_SERVER_ID);
  });

  protected readonly variantOptions = LLAMA_SERVER_VARIANTS;
  protected readonly variantLabels = LLAMA_SERVER_VARIANT_LABELS;
  protected readonly whisperSizeOptions = WHISPER_MODEL_OPTIONS;

  protected variantPillOptions(): { id: string; label: string }[] {
    return this.variantOptions.map((variant) => ({ id: variant, label: this.variantLabels[variant] }));
  }

  private readonly logBodies = viewChildren<ElementRef<HTMLElement>>('logBody');

  private configSub: { unsubscribe(): void } | null = null;
  private offProgress: (() => void) | null = null;
  private destroyed = false;

  constructor() {
    effect(() => {
      const loading = this.firstLoad();
      untracked(() => this.scheduleNamedSpinnerSync(this.listSpinnerName, loading));
    });
    // Auto-scroll any open log panels to the bottom when new lines arrive.
    // Deferred to the next animation frame so the browser has laid out the
    // newly rendered log lines before we read scrollHeight (otherwise the
    // last line can end up hidden behind the bottom edge).
    effect(() => {
      this.logById();
      untracked(() => {
        requestAnimationFrame(() => {
          for (const ref of this.logBodies()) {
            const el = ref.nativeElement;
            el.scrollTop = el.scrollHeight;
          }
        });
      });
    });
  }

  async ngOnInit(): Promise<void> {
    let receivedConfigUpdate = false;
    this.configSub = this.electron.config$.subscribe((config: AppConfig) => {
      receivedConfigUpdate = true;
      this.applyTheme(config);
    });
    this.offProgress = this.electron.onDepsProgress((ev) => this.onProgress(ev));
    // A slow or failed appearance config must not keep dependency status at "checking".
    // Do not let a late initial response overwrite a newer config broadcast.
    void Promise.resolve()
      .then(() => this.destroyed ? null : this.electron.loadConfig())
      .then((config) => {
        if (config && !this.destroyed && !receivedConfigUpdate) this.applyTheme(config);
      })
      .catch(() => {});
    await this.refreshList();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.configSub?.unsubscribe();
    this.offProgress?.();
    for (const timer of this.rowMessageTimers.values()) clearTimeout(timer);
    void this.ngxSpinner.hide(this.listSpinnerName);
  }

  protected closeWindow(): void {
    this.electron.closeDependenciesWindow();
  }

  /** Whisper reports `missing` when its packages are absent even if model weights are cached. */
  protected displayState(dep: DependencyInfo): DependencyDisplayState {
    if (this.isWhisper(dep) && dep.state === 'missing' && (dep.downloadedModels?.length ?? 0) > 0) {
      return 'partial';
    }
    return dep.state;
  }

  protected stateLabel(state: DependencyDisplayState): string {
    switch (state) {
      case 'partial':
        return 'Partial';
      case 'installed':
        return 'Installed';
      case 'missing':
        return 'Missing';
      case 'updating':
        return 'Updating';
      case 'error':
        return 'Error';
      default:
        return state;
    }
  }

  protected isBusy(id: DependencyId): boolean {
    return this.pendingActionIds().has(id) || this.busyIds().has(id) || this.cancellingIds().has(id) ||
      this.dependencies().find((d) => d.id === id)?.state === 'updating';
  }

  protected isLlamaServer(dep: DependencyInfo): boolean {
    return dep.id === LLAMA_SERVER_ID;
  }

  protected isWhisper(dep: DependencyInfo): boolean {
    return dep.id === WHISPER_ID;
  }

  protected isKokoro(dep: DependencyInfo): boolean {
    return dep.id === KOKORO_ID;
  }

  /** Kokoro/Whisper installs are parked while voice chat is unavailable. */
  protected downloadComingSoon(dep: DependencyInfo): boolean {
    return this.isKokoro(dep) || this.isWhisper(dep);
  }

  protected whisperSizeFor(dep: DependencyInfo): string {
    return this.whisperSizeById()[dep.id] ?? DEFAULT_WHISPER_MODEL;
  }

  protected setWhisperSize(dep: DependencyInfo, size: string): void {
    this.whisperSizeById.update((m) => ({ ...m, [dep.id]: size }));
  }

  protected whisperSizeDownloaded(dep: DependencyInfo): boolean {
    return (dep.downloadedModels ?? []).includes(this.whisperSizeFor(dep));
  }

  protected showDownload(dep: DependencyInfo): boolean {
    if (dep.state === 'missing' || dep.state === 'error') return true;
    return this.isWhisper(dep) && !this.whisperSizeDownloaded(dep);
  }

  protected installVariant(dep: DependencyInfo): string | null {
    if (this.isWhisper(dep)) return this.whisperSizeFor(dep);
    if (this.isLlamaServer(dep)) return this.variantFor(dep);
    return null;
  }

  protected isInstalling(): boolean {
    return this.activeId() !== null;
  }

  protected isFailed(): boolean {
    const id = this.activeId();
    return id !== null && this.failedId() === id;
  }

  /** A previous run of this dependency left output to look at (shown as "View log" on error rows). */
  protected hasLog(dep: DependencyInfo): boolean {
    return this.logFor(dep.id).length > 0;
  }

  protected viewLog(dep: DependencyInfo): void {
    this.failedId.set(dep.id);
    this.activeId.set(dep.id);
  }

  protected backToList(): void {
    this.failedId.set(null);
    this.activeId.set(null);
  }

  /** Retry repeats the last action; only a download retry is the tour’s install control. */
  protected retryIsDownload(dep: DependencyInfo): boolean {
    return this.lastAction.get(dep.id) !== 'reinstall';
  }

  protected retry(dep: DependencyInfo): void {
    this.failedId.set(null);
    if (this.retryIsDownload(dep)) void this.download(dep);
    else void this.reinstall(dep);
  }

  protected activeDep(): DependencyInfo | undefined {
    const id = this.activeId();
    if (!id) return undefined;
    return this.dependencies().find((d) => d.id === id);
  }

  protected progressFor(id: DependencyId): DependencyProgressEvent | undefined {
    return this.progressById()[id];
  }

  /** Phase, percent, and "61.2 MB of 145.8 MB · 31 MB/s · ~3 s left" for the focused install. */
  protected progressViewFor(id: DependencyId): ProgressView {
    return progressView(this.progressFor(id), this.speedById()[id], this.logPercent(id));
  }

  protected isCancelling(id: DependencyId): boolean {
    return this.cancellingIds().has(id);
  }

  /**
   * Stop the running install. The backend removes partial files before it reports back,
   * so the row ends up either untouched (still installed) or cleanly missing.
   */
  protected async cancelInstall(dep: DependencyInfo): Promise<void> {
    if (this.isCancelling(dep.id)) return;
    this.cancellingIds.update((s) => new Set(s).add(dep.id));
    let res: { ok: boolean; error?: string };
    try {
      res = await this.electron.depsCancel(dep.id);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok && this.isCancelling(dep.id)) {
      this.cancellingIds.update((s) => {
        const next = new Set(s);
        next.delete(dep.id);
        return next;
      });
      this.setRowMessage(dep.id, 'error', `Couldn't cancel: ${res.error ?? 'unknown error'}`);
    }
  }

  protected rowMessage(id: DependencyId): RowMessage | undefined {
    return this.rowMessages()[id];
  }

  private setRowMessage(id: DependencyId, tone: RowMessage['tone'], text: string): void {
    clearTimeout(this.rowMessageTimers.get(id));
    this.rowMessages.update((m) => ({ ...m, [id]: { tone, text } }));
    if (tone !== 'error') {
      this.rowMessageTimers.set(
        id,
        setTimeout(() => this.clearRowMessage(id), ROW_MESSAGE_MS),
      );
    }
  }

  private clearRowMessage(id: DependencyId): void {
    clearTimeout(this.rowMessageTimers.get(id));
    this.rowMessageTimers.delete(id);
    this.rowMessages.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }

  /** Dropdown starts on the installed build so it reflects what's on disk. */
  protected variantFor(dep: DependencyInfo): LlamaServerVariant {
    return this.variantById()[dep.id] ?? installedLlamaVariant(dep) ?? 'auto';
  }

  /** Explains that a different build only takes effect after a reinstall; null when nothing changes. */
  protected variantHint(dep: DependencyInfo): string | null {
    const installed = installedLlamaVariant(dep);
    const chosen = this.variantFor(dep);
    if (!installed || chosen === installed) return null;
    if (chosen === 'auto') return 'Reinstall to let Clara pick the best build for this machine.';
    return `Installed: ${this.variantLabels[installed]}. Reinstall to switch to ${this.variantLabels[chosen]}.`;
  }

  protected setVariant(dep: DependencyInfo, v: LlamaServerVariant): void {
    this.variantById.update((m) => ({ ...m, [dep.id]: v }));
  }

  protected logFor(id: DependencyId): LogEntry[] {
    return this.logById()[id] ?? [];
  }

  /** Sub-dependencies the install drops on disk (provider list, else static catalog). */
  protected componentsFor(dep: DependencyInfo): string[] {
    return dependencyComponents(dep);
  }

  /** Upstream origins for the Details section; Whisper adds a model repo per downloaded/selected size. */
  protected sourcesFor(dep: DependencyInfo): readonly DependencySource[] {
    const base = DEPENDENCY_SOURCES[dep.id] ?? [];
    if (!this.isWhisper(dep)) return base;
    const sizes = [...new Set([...(dep.downloadedModels ?? []), this.whisperSizeFor(dep)])];
    const models = sizes
      .filter((size) => WHISPER_SIZE_REPOS[size])
      .map((size) => whisperModelSource(size, WHISPER_SIZE_REPOS[size]!));
    return [...base, ...models];
  }

  protected isDetailsOpen(dep: DependencyInfo): boolean {
    return this.expandedDetails().has(dep.id);
  }

  protected toggleDetails(dep: DependencyInfo): void {
    this.expandedDetails.update((s) => {
      const next = new Set(s);
      if (next.has(dep.id)) next.delete(dep.id);
      else next.add(dep.id);
      return next;
    });
  }

  protected async revealPath(dep: DependencyInfo): Promise<void> {
    const res = await this.electron.depsReveal(dep.id);
    if (!res.ok) this.setRowMessage(dep.id, 'error', `Couldn't open the folder: ${res.error ?? 'unknown error'}`);
  }

  protected async copyPath(dep: DependencyInfo): Promise<void> {
    if (!dep.path) return;
    try {
      await navigator.clipboard.writeText(dep.path);
      this.setRowMessage(dep.id, 'ok', 'Path copied.');
    } catch {
      this.setRowMessage(dep.id, 'error', "Couldn't copy the path.");
    }
  }

  /**
   * Short size label for the row pill, e.g. "~40–400 MB" from
   * "~40–400 MB (CPU ~40 MB; CUDA build …)". The full hint goes in the tooltip.
   */
  protected sizeShort(hint: string): string {
    const idx = hint.indexOf(' (');
    return (idx > 0 ? hint.slice(0, idx) : hint).trim();
  }

  /** Maps SGR color codes to CSS colors (basic 8 + bright 8). */
  private static readonly ANSI_COLORS: Record<number, string> = {
    30: '#000000', 31: '#cc4444', 32: '#4e9a4e', 33: '#c4a000', 34: '#3666c9',
    35: '#a03cb0', 36: '#3aa6c4', 37: '#d4d7dd',
    90: '#666666', 91: '#ff6b6b', 92: '#7bd07c', 93: '#e6c44a', 94: '#7aa6ff',
    95: '#d59cdf', 96: '#7adfe0', 97: '#ffffff',
  };

  /**
   * Render an install log line (which may contain ANSI SGR escape sequences) as
   * colored HTML. HTML specials are escaped first, so the only tags in the output
   * are the ``<span>`` runs we emit for colors — safe to bind via innerHTML.
   */
  protected ansiToHtml(input: string): SafeHtml {
    const escaped = input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    let out = '';
    let open = false;
    const closeSpan = () => {
      if (open) {
        out += '</span>';
        open = false;
      }
    };
    const openSpan = (s: string) => {
      out += `<span style="${s}">`;
      open = true;
    };
    // Match ESC [ params m  (SGR) and other ESC [ ... final-letter sequences.
    const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(escaped)) !== null) {
      out += escaped.slice(last, m.index);
      last = re.lastIndex;
      const params = m[1].split(';').filter(Boolean).map((n) => parseInt(n, 10));
      const cmd = m[2];
      if (cmd === 'm') {
        let color = '';
        let bold = false;
        let dim = false;
        for (const p of params) {
          if (p === 0) {
            color = '';
            bold = false;
            dim = false;
          } else if (p === 1) bold = true;
          else if (p === 2) dim = true;
          else if (p === 22) {
            bold = false;
            dim = false;
          } else if (p === 39 || p === 49) {
            // default fg / bg — drop the corresponding color.
            color = '';
          } else if (Dependencies.ANSI_COLORS[p]) {
            color = Dependencies.ANSI_COLORS[p];
          }
        }
        closeSpan();
        const parts: string[] = [];
        if (color) parts.push(`color:${color}`);
        if (bold) parts.push('font-weight:600');
        if (dim) parts.push('opacity:0.7');
        if (parts.length) openSpan(parts.join(';'));
        // When there is no active style, leave the span closed so text appends raw.
      }
      // Non-SGR CSI sequences (cursor movement, erase, etc.) are stripped.
    }
    out += escaped.slice(last);
    closeSpan();
    return this.sanitizer.bypassSecurityTrustHtml(out);
  }

  /**
   * Fallback percent when there's no byte total: the most recent ``[NN%]`` in the log
   * (e.g. ``[installing] [50%]`` -> 50), or ``null`` when the install reports none.
   */
  private logPercent(depId: DependencyId): number | null {
    const lines = this.logFor(depId);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].message.match(/\[\s*(\d{1,3})%\]/);
      if (m) return Math.min(100, Math.max(0, parseInt(m[1], 10)));
    }
    return null;
  }

  protected refreshList(): Promise<DependencyListRefresh> {
    // Do not make an install wait forever for an older status request which has been
    // superseded by a newer one. The old IPC result is still ignored when it arrives.
    this.supersedeListRefresh?.();
    const version = ++this.listRefreshVersion;
    this.listLoading.set(true);
    let supersede!: () => void;
    const superseded = new Promise<DependencyListRefresh>((resolve) => {
      supersede = () => resolve({ superseded: true, dependencies: null });
    });
    this.supersedeListRefresh = supersede;
    const request = Promise.race([this.loadDependencyList(version), superseded]).then((result) => {
      if (this.supersedeListRefresh === supersede) this.supersedeListRefresh = null;
      return result;
    });
    this.latestListRefresh = request;
    return request;
  }

  private async loadDependencyList(version: number): Promise<DependencyListRefresh> {
    try {
      const res = await this.electron.depsList();
      if (version !== this.listRefreshVersion) return { superseded: true, dependencies: null };
      if (!res.ok) {
        this.statusMessage.set(res.error || 'Failed to list dependencies.');
        this.listStatusTrusted.set(false);
        // Keep an existing focused install visible even if a status refresh fails.
        return { superseded: false, dependencies: null };
      }
      const deps = res.dependencies ?? [];
      const llama = deps.find((dep) => dep.id === LLAMA_SERVER_ID);
      const trusted = !res.warning && !!llama;
      this.dependencies.set(deps);
      this.listStatusTrusted.set(trusted);
      if (trusted && llama?.state !== 'installed' && this.llamaTutorialOutcome() === 'success') {
        this.llamaTutorialOutcome.set(null);
      }
      if (res.warning) {
        this.statusMessage.set(res.warning);
      } else if (!deps.length) {
        this.statusMessage.set('No dependencies reported.');
      } else {
        this.statusMessage.set('');
      }
      return { superseded: false, dependencies: trusted ? deps : null };
    } catch (err) {
      if (version !== this.listRefreshVersion) return { superseded: true, dependencies: null };
      this.statusMessage.set(err instanceof Error ? err.message : String(err));
      this.listStatusTrusted.set(false);
      return { superseded: false, dependencies: null };
    } finally {
      if (version === this.listRefreshVersion) this.listLoading.set(false);
    }
  }

  /** An action must be verified by a status request begun after its own result. */
  private async refreshAfterAction(): Promise<DependencyInfo[] | null> {
    let result = await this.refreshList();
    // A later request also began after the action; wait for it rather than trusting a stale response.
    while (result.superseded && this.latestListRefresh) result = await this.latestListRefresh;
    return result.superseded ? null : result.dependencies;
  }

  protected async download(dep: DependencyInfo): Promise<void> {
    if (this.downloadComingSoon(dep)) return;
    this.lastAction.set(dep.id, 'download');
    await this.runAction(dep, () => this.electron.depsInstall(dep.id, this.installVariant(dep)), 'Downloaded', {
      focus: true,
    });
  }

  protected async reinstall(dep: DependencyInfo): Promise<void> {
    if (this.downloadComingSoon(dep)) return;
    this.lastAction.set(dep.id, 'reinstall');
    await this.runAction(dep, () => this.electron.depsReinstall(dep.id, this.installVariant(dep)), 'Reinstalled', {
      focus: true,
    });
  }

  protected async remove(dep: DependencyInfo): Promise<void> {
    if (!dep.canDelete) return;
    const confirmed =
      (await this.themedConfirm.open(dependencyDeletePrompt({ id: dep.id, label: dep.label, path: dep.path }))) ===
      'confirm';
    if (!confirmed) return;
    // Delete is quick and has no compile step; keep the normal list view.
    await this.runAction(dep, () => this.electron.depsDelete(dep.id), 'Removed', { focus: false });
  }

  private async runAction(
    dep: DependencyInfo,
    action: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>,
    successVerb: string,
    opts: { focus: boolean },
  ): Promise<void> {
    const id = dep.id;
    if (this.pendingActionIds().has(id) || this.isBusy(id)) return;
    const isLlama = id === LLAMA_SERVER_ID;
    if (isLlama) this.llamaTutorialOutcome.set(null);
    this.pendingActionIds.update((s) => new Set(s).add(id));
    this.busyIds.update((s) => new Set(s).add(id));
    this.clearRowMessage(id);
    // Fresh log buffer and rate estimate for this action.
    this.logById.update((m) => ({ ...m, [id]: [] }));
    this.speedById.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    if (opts.focus) {
      this.failedId.set(null);
      this.activeId.set(id);
    }
    try {
      let res: { ok: boolean; error?: string; cancelled?: boolean };
      try {
        res = await action();
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      let cancelled = !!res.cancelled || (isLlama && (this.llamaTutorialOutcome() === 'cancelled' || this.isCancelling(id)));
      let failed = !res.ok || (isLlama && this.llamaTutorialOutcome() === 'error');
      if (cancelled) {
        if (isLlama) this.llamaTutorialOutcome.set('cancelled');
        this.finishCancel(id);
      } else if (failed) {
        if (isLlama) this.llamaTutorialOutcome.set('error');
        if (opts.focus && this.activeId() === id) this.failedId.set(id);
      } else {
        this.progressById.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }

      // A `done` progress event is also emitted for deletion/cleanup. Only this action's
      // successful install result, followed by a trustworthy installed status, is success.
      const refreshed = await this.refreshAfterAction();
      let verificationError = '';
      if (isLlama) {
        cancelled ||= this.llamaTutorialOutcome() === 'cancelled';
        failed ||= this.llamaTutorialOutcome() === 'error';
        if (cancelled) {
          this.llamaTutorialOutcome.set('cancelled');
        } else if (failed) {
          this.llamaTutorialOutcome.set('error');
        } else if (opts.focus) {
          if (refreshed?.some((item) => item.id === LLAMA_SERVER_ID && item.state === 'installed')) {
            this.llamaTutorialOutcome.set('success');
          } else {
            failed = true;
            this.llamaTutorialOutcome.set('error');
            verificationError = 'Install finished, but llama-server could not be verified as installed.';
          }
        }
      }
      if (cancelled) {
        // The 'cancelled' progress event carries the cleanup outcome; fill in only if it never arrived.
        if (!this.rowMessage(id)) this.setRowMessage(id, 'info', 'Install cancelled.');
      } else if (failed) {
        if (opts.focus && this.activeId() === id) this.failedId.set(id);
        const progressError = this.rowMessage(id);
        this.setRowMessage(
          id,
          'error',
          verificationError || res.error || (progressError?.tone === 'error' ? progressError.text : `${dep.label} failed.`),
        );
      } else {
        this.setRowMessage(id, 'ok', `${successVerb} ${dep.label}.`);
      }
    } finally {
      this.pendingActionIds.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      // Do not disturb a different dependency's focused install.
      if (this.activeId() === id && this.failedId() !== id) {
        this.activeId.set(null);
      }
    }
  }

  /** Cleanup finished: leave the cancelling state and go back to the list. */
  private finishCancel(id: DependencyId): void {
    this.cancellingIds.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    this.busyIds.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    this.progressById.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    if (this.activeId() === id) {
      this.failedId.set(null);
      this.activeId.set(null);
    }
  }

  private onProgress(ev: DependencyProgressEvent): void {
    const localAction = this.pendingActionIds().has(ev.depId);
    if (ev.depId === LLAMA_SERVER_ID) {
      if (ev.phase === 'queued' && !localAction && !this.isCancelling(ev.depId)) {
        this.llamaTutorialOutcome.set(null);
      } else if (ev.phase === 'error' || ev.phase === 'cancelled') {
        this.llamaTutorialOutcome.set(ev.phase);
      }
    }
    if (ev.phase === 'cancelling') {
      this.cancellingIds.update((s) => new Set(s).add(ev.depId));
    }
    if (ev.phase === 'cancelled') {
      this.appendLog(ev);
      this.finishCancel(ev.depId);
      const message = ev.message;
      if (localAction) {
        if (message) this.setRowMessage(ev.depId, 'info', message);
      } else {
        void this.refreshList().then(() => {
          if (message) this.setRowMessage(ev.depId, 'info', message);
        });
      }
      return;
    }
    // Cleanup after a cancel deletes the partial install, which reports 'done' ("… removed"):
    // that is not a finished install, so keep the cancelling view until 'cancelled'.
    if (ev.phase === 'done' && this.isCancelling(ev.depId)) {
      this.appendLog(ev);
      return;
    }
    this.progressById.update((m) => ({ ...m, [ev.depId]: ev }));
    if (ev.phase === 'downloading' && ev.bytesDone != null) {
      const bytes = ev.bytesDone;
      this.speedById.update((m) => ({ ...m, [ev.depId]: nextSpeedSample(m[ev.depId], bytes, Date.now()) }));
    }
    this.appendLog(ev);
    if (RUNNING_PHASES.has(ev.phase)) {
      this.busyIds.update((s) => new Set(s).add(ev.depId));
    }
    if (ev.phase === 'done' || ev.phase === 'error') {
      if (ev.phase === 'error') {
        if (ev.message) this.setRowMessage(ev.depId, 'error', ev.message);
        if (this.activeId() === ev.depId) this.failedId.set(ev.depId);
      }
      // A local action is still in flight even if a progress event says done/error.
      // Its IPC result and post-result status refresh own the final transition.
      if (!localAction) {
        this.busyIds.update((s) => {
          const next = new Set(s);
          next.delete(ev.depId);
          return next;
        });
        if (ev.phase === 'done' && this.activeId() === ev.depId) this.activeId.set(null);
        void this.refreshList();
      }
    }
  }

  private appendLog(ev: DependencyProgressEvent): void {
    if (!ev.message) return;
    const message = ev.message;
    this.logById.update((m) => {
      const prev = m[ev.depId] ?? [];
      // Byte-progress events repeat the same "Downloading <file>…" text per chunk; the
      // progress bar shows the bytes, so keep one log line per step.
      const last = prev[prev.length - 1];
      if (last && last.phase === ev.phase && last.message === message) return m;
      const next = [...prev, { ts: Date.now(), phase: ev.phase, message }];
      const trimmed = next.length > LOG_MAX_LINES ? next.slice(next.length - LOG_MAX_LINES) : next;
      return { ...m, [ev.depId]: trimmed };
    });
  }


  /** Theme itself is painted by ThemeEngineService (started in AppShell); fonts are per-window. */
  private applyTheme(config: AppConfig): void {
    applyAppFontOverrides(config);
  }

  private scheduleNamedSpinnerSync(name: string, show: boolean): void {
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (show) void this.ngxSpinner.show(name);
      else void this.ngxSpinner.hide(name);
    });
  }
}
