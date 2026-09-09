import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
  effect,
  untracked,
  viewChildren,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type {
  AppConfig,
  DependencyId,
  DependencyInfo,
  DependencyProgressEvent,
  LlamaServerVariant,
} from '@shared/index';
import {
  DEFAULT_WHISPER_MODEL,
  LLAMA_SERVER_VARIANTS,
  LLAMA_SERVER_VARIANT_LABELS,
  WHISPER_MODEL_OPTIONS,
  dependencyComponents,
} from '@shared/index';
import { THEMES } from '../../layout/theme-selector/theme-selector';
import { resolveAppThemeId, applyAppFontOverrides } from '../../shell/app-theme';
import { ElectronService } from '../../../core/electron.service';

interface LogEntry {
  ts: number;
  phase: string;
  message: string;
}

const LOG_MAX_LINES = 1000;
/** Component chips shown per row before collapsing the rest behind "+N more". */
const COMPONENT_PREVIEW = 6;
const LLAMA_SERVER_ID = 'llama-server';
const KOKORO_ID = 'kokoro';
const WHISPER_ID = 'whisper';

@Component({
  selector: 'app-dependencies',
  imports: [NgxSpinnerComponent],
  templateUrl: './dependencies.html',
  styleUrl: './dependencies.css',
})
export class Dependencies implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly listSpinnerName = 'deps-list-spinner';
  protected readonly listSpinnerType = 'ball-scale-multiple';

  protected readonly dependencies = signal<DependencyInfo[]>([]);
  protected readonly listLoading = signal(true);
  protected readonly statusMessage = signal('');
  protected readonly busyIds = signal<Set<DependencyId>>(new Set());
  protected readonly progressById = signal<Partial<Record<DependencyId, DependencyProgressEvent>>>({});
  protected readonly logById = signal<Partial<Record<DependencyId, LogEntry[]>>>({});
  protected readonly variantById = signal<Partial<Record<DependencyId, LlamaServerVariant>>>({});
  protected readonly whisperSizeById = signal<Partial<Record<DependencyId, string>>>({});
  /** Rows whose full component list is expanded (default shows a short preview). */
  protected readonly expandedComponents = signal<Set<DependencyId>>(new Set());

  /**
   * When set, the window switches from the full list to a focused view showing
   * only this dependency's card plus a live terminal log. Cleared on done/error.
   */
  protected readonly activeId = signal<DependencyId | null>(null);

  protected readonly variantOptions = LLAMA_SERVER_VARIANTS;
  protected readonly variantLabels = LLAMA_SERVER_VARIANT_LABELS;
  protected readonly whisperSizeOptions = WHISPER_MODEL_OPTIONS;

  private readonly logBodies = viewChildren<ElementRef<HTMLElement>>('logBody');

  private configSub: { unsubscribe(): void } | null = null;
  private offProgress: (() => void) | null = null;

  constructor() {
    effect(() => {
      const loading = this.listLoading();
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
    const cfg = await this.electron.loadConfig();
    this.applyTheme(cfg);
    this.configSub = this.electron.config$.subscribe((c: AppConfig) => this.applyTheme(c));
    this.offProgress = this.electron.onDepsProgress((ev) => this.onProgress(ev));
    await this.refreshList();
  }

  ngOnDestroy(): void {
    this.configSub?.unsubscribe();
    this.offProgress?.();
    void this.ngxSpinner.hide(this.listSpinnerName);
  }

  protected closeWindow(): void {
    this.electron.closeDependenciesWindow();
  }

  protected stateLabel(state: DependencyInfo['state']): string {
    switch (state) {
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
    return this.busyIds().has(id) || this.dependencies().find((d) => d.id === id)?.state === 'updating';
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

  protected activeDep(): DependencyInfo | undefined {
    const id = this.activeId();
    if (!id) return undefined;
    return this.dependencies().find((d) => d.id === id);
  }

  protected progressFor(id: DependencyId): DependencyProgressEvent | undefined {
    return this.progressById()[id];
  }

  protected progressPercent(ev: DependencyProgressEvent | undefined): number | null {
    if (!ev?.bytesDone || !ev.bytesTotal || ev.bytesTotal <= 0) return null;
    return Math.min(100, Math.round((ev.bytesDone / ev.bytesTotal) * 100));
  }

  protected formatBytes(n: number | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected variantFor(dep: DependencyInfo): LlamaServerVariant {
    return this.variantById()[dep.id] ?? 'auto';
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

  protected visibleComponents(dep: DependencyInfo): string[] {
    const all = this.componentsFor(dep);
    if (this.expandedComponents().has(dep.id)) return all;
    return all.slice(0, COMPONENT_PREVIEW);
  }

  /** How many chips are hidden behind the "+N more" toggle (0 when fully shown). */
  protected hiddenComponentCount(dep: DependencyInfo): number {
    if (this.expandedComponents().has(dep.id)) return 0;
    return Math.max(0, this.componentsFor(dep).length - COMPONENT_PREVIEW);
  }

  protected isComponentsExpanded(dep: DependencyInfo): boolean {
    return this.expandedComponents().has(dep.id);
  }

  protected toggleComponents(dep: DependencyInfo): void {
    this.expandedComponents.update((s) => {
      const next = new Set(s);
      if (next.has(dep.id)) next.delete(dep.id);
      else next.add(dep.id);
      return next;
    });
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
    let style = '';
    let open = false;
    const closeSpan = () => {
      if (open) {
        out += '</span>';
        open = false;
      }
    };
    const openSpan = (s: string) => {
      style = s;
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
   * Progress percent for the active install. Prefers byte progress (download
   * phase); otherwise scans the log for the most recent ``[NN%]`` bracket pair
   * (e.g. ``[installing] [50%]`` -> 50) and uses that. Returns ``null`` when no
   * progress signal is available.
   */
  protected installPercent(depId: DependencyId): number | null {
    const prog = this.progressFor(depId);
    const bytePct = this.progressPercent(prog);
    if (bytePct != null) return bytePct;
    const lines = this.logFor(depId);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].message.match(/\[\s*(\d{1,3})%\]/);
      if (m) return Math.min(100, Math.max(0, parseInt(m[1], 10)));
    }
    return null;
  }

  protected async refreshList(): Promise<void> {
    this.listLoading.set(true);
    try {
      const res = await this.electron.depsList();
      if (!res.ok) {
        this.statusMessage.set(res.error || 'Failed to list dependencies.');
        this.dependencies.set([]);
        return;
      }
      this.dependencies.set(res.dependencies ?? []);
      if (res.warning) {
        this.statusMessage.set(res.warning);
      } else if (!res.dependencies?.length) {
        this.statusMessage.set('No dependencies reported.');
      }
    } catch (err) {
      this.statusMessage.set(err instanceof Error ? err.message : String(err));
      this.dependencies.set([]);
    } finally {
      this.listLoading.set(false);
    }
  }

  protected async download(dep: DependencyInfo): Promise<void> {
    if (this.downloadComingSoon(dep)) return;
    await this.runAction(dep.id, () => this.electron.depsInstall(dep.id, this.installVariant(dep)), 'Downloaded', {
      focus: true,
    });
  }

  protected async reinstall(dep: DependencyInfo): Promise<void> {
    if (this.downloadComingSoon(dep)) return;
    await this.runAction(dep.id, () => this.electron.depsReinstall(dep.id, this.installVariant(dep)), 'Reinstalled', {
      focus: true,
    });
  }

  protected async remove(dep: DependencyInfo): Promise<void> {
    if (!dep.canDelete) return;
    // Delete is quick and has no compile step; keep the normal list view.
    await this.runAction(dep.id, () => this.electron.depsDelete(dep.id), 'Removed', { focus: false });
  }

  private async runAction(
    id: DependencyId,
    action: () => Promise<{ ok: boolean; error?: string }>,
    successVerb: string,
    opts: { focus: boolean },
  ): Promise<void> {
    this.busyIds.update((s) => new Set(s).add(id));
    this.statusMessage.set('');
    // Fresh log buffer for this action.
    this.logById.update((m) => ({ ...m, [id]: [] }));
    if (opts.focus) {
      this.activeId.set(id);
    }
    try {
      const res = await action();
      if (!res.ok) {
        this.statusMessage.set(res.error || `${id} failed.`);
      } else {
        this.statusMessage.set(`${successVerb} ${id}.`);
        this.progressById.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
      await this.refreshList();
    } finally {
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      // Safety net: if no done/error event arrived (e.g. delete), return to the list.
      if (this.activeId() === id) {
        this.activeId.set(null);
      }
    }
  }

  private onProgress(ev: DependencyProgressEvent): void {
    this.progressById.update((m) => ({ ...m, [ev.depId]: ev }));
    if (ev.message) {
      this.logById.update((m) => {
        const prev = m[ev.depId] ?? [];
        const next = [...prev, { ts: Date.now(), phase: ev.phase, message: ev.message }];
        const trimmed = next.length > LOG_MAX_LINES ? next.slice(next.length - LOG_MAX_LINES) : next;
        return { ...m, [ev.depId]: trimmed };
      });
    }
    if (
      ev.phase === 'queued' ||
      ev.phase === 'downloading' ||
      ev.phase === 'extracting' ||
      ev.phase === 'installing' ||
      ev.phase === 'finishing'
    ) {
      this.busyIds.update((s) => new Set(s).add(ev.depId));
    }
    if (ev.phase === 'done' || ev.phase === 'error') {
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(ev.depId);
        return next;
      });
      if (ev.phase === 'error' && ev.message) {
        this.statusMessage.set(ev.message);
      }
      // Return to the full dependencies list on completion.
      if (this.activeId() === ev.depId) {
        this.activeId.set(null);
      }
      void this.refreshList();
    }
  }

  private applyTheme(config: AppConfig): void {
    const theme = THEMES.find((t) => t.id === resolveAppThemeId(config)) ?? THEMES[0];
    document.documentElement.className = theme.cssClass;
    document.documentElement.setAttribute('data-bs-theme', theme.bsTheme);
    applyAppFontOverrides(config);
  }

  private scheduleNamedSpinnerSync(name: string, show: boolean): void {
    queueMicrotask(() => {
      if (show) void this.ngxSpinner.show(name);
      else void this.ngxSpinner.hide(name);
    });
  }
}
