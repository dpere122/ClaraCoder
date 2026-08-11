import {
  Component,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import type { AppConfig, HealthLogLevel, HealthLogRecord } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HealthLogMessagePipe, type HealthLogMessageFormat } from './health-log-message.pipe';
import { estimateHealthLogRowHeight, healthLogVirtualWindow } from './health-log-virtual';

const MAX_ENTRIES = 2500;

@Component({
  selector: 'app-health-log-viewer',
  imports: [FormsModule, HealthLogMessagePipe],
  templateUrl: './health-log-viewer.html',
  styleUrl: './health-log-viewer.css',
})
export class HealthLogViewer implements OnInit, OnDestroy {
  private readonly inj = inject(Injector);

  /** When true, metrics charts are hidden in the parent and the log is expanded. */
  readonly logExpanded = input(false);
  readonly logExpandedToggle = output<void>();

  protected readonly searchQuery = signal('');
  protected readonly autoScroll = signal(true);
  protected readonly logLevelFilter = signal<string>('ALL');
  protected readonly logVerbosity = signal<HealthLogLevel>('info');
  protected readonly messageFormat = signal<HealthLogMessageFormat>('raw');

  protected readonly entries = signal<HealthLogRecord[]>([]);
  private readonly seenSeq = new Set<number>();
  private sub: Subscription | null = null;
  private configSub: Subscription | null = null;

  protected readonly logViewport = viewChild<ElementRef<HTMLElement>>('logViewport');

  /** Measured or estimated height per visible-filtered row (index-aligned with filteredEntries). */
  private readonly rowHeights = signal<number[]>([]);
  private readonly scrollTopSig = signal(0);
  private readonly viewportHeightSig = signal(0);
  private measurePassScheduled = false;
  private scrollToBottomRaf = 0;
  private logScrollRaf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private lastFilterKey: string | null = null;
  private lastFmt: HealthLogMessageFormat | null = null;

  protected readonly filteredEntries = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const lvl = this.logLevelFilter();
    const order: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };
    const minRank = lvl === 'ALL' ? -1 : order[lvl] ?? -1;

    return this.entries().filter((e) => {
      if (minRank >= 0 && (order[e.level] ?? 1) < minRank) return false;
      if (!q) return true;
      const hay = `${e.logger} ${e.message} ${e.source}`.toLowerCase();
      return hay.includes(q);
    });
  });

  protected readonly filterKey = computed(
    () => `${this.logLevelFilter()}\0${this.searchQuery().trim().toLowerCase()}`,
  );

  protected readonly virtualWindow = computed(() =>
    healthLogVirtualWindow(
      this.filteredEntries(),
      this.rowHeights(),
      this.scrollTopSig(),
      this.viewportHeightSig(),
    ),
  );

  constructor(private electron: ElectronService) {
    const inj = this.inj;

    afterNextRender(
      () => {
        const el = this.logViewport()?.nativeElement;
        if (!el) return;
        this.viewportHeightSig.set(el.clientHeight);
        this.resizeObserver = new ResizeObserver(() => {
          this.viewportHeightSig.set(el.clientHeight);
        });
        this.resizeObserver.observe(el);
      },
      { injector: inj },
    );

    effect(
      () => {
        const rows = this.filteredEntries();
        const fmt = this.messageFormat();
        const fk = this.filterKey();
        untracked(() => {
          const filterOrFmtChanged =
            this.lastFilterKey === null || fk !== this.lastFilterKey || fmt !== this.lastFmt;
          if (filterOrFmtChanged) {
            this.lastFilterKey = fk;
            this.lastFmt = fmt;
            this.rowHeights.set(rows.map((r) => estimateHealthLogRowHeight(r, fmt)));
            return;
          }
          const prev = this.rowHeights();
          if (rows.length < prev.length) {
            this.rowHeights.set(rows.map((r) => estimateHealthLogRowHeight(r, fmt)));
            return;
          }
          this.rowHeights.set(
            rows.map((r, i) => (i < prev.length ? prev[i]! : estimateHealthLogRowHeight(r, fmt))),
          );
        });
      },
      { injector: inj },
    );

    effect(
      () => {
        this.virtualWindow();
        untracked(() => this.scheduleMeasureVisibleRows());
      },
      { injector: inj },
    );
  }

  async ngOnInit(): Promise<void> {
    if (this.electron.isElectron) {
      const recent = await this.electron.healthLogsRecent(1200);
      this.mergeRecords(recent);
      this.electron.healthLogsSubscribe();
      this.sub = this.electron.healthLogRecord$.subscribe((rec) => this.mergeRecords([rec]));
    }

    const cfg = await this.electron.loadConfig();
    this.logVerbosity.set(cfg.healthMonitor.logLevel);

    this.configSub = this.electron.config$.subscribe((c: AppConfig) => {
      this.logVerbosity.set(c.healthMonitor.logLevel);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.scrollToBottomRaf);
    cancelAnimationFrame(this.logScrollRaf);
    this.sub?.unsubscribe();
    this.configSub?.unsubscribe();
    if (this.electron.isElectron) {
      this.electron.healthLogsUnsubscribe();
    }
  }

  protected async onVerbosityChange(level: HealthLogLevel): Promise<void> {
    this.logVerbosity.set(level);
    await this.electron.patchHealthMonitor({ logLevel: level });
    await this.electron.healthSetLogLevel(level);
  }

  private mergeRecords(recs: HealthLogRecord[]): void {
    if (recs.length === 0) return;
    const cur = this.entries();
    const next = cur.slice();
    let appended = 0;
    let needsSort = false;
    let runningMax = cur.length ? cur[cur.length - 1]!.seq : -Infinity;
    for (const r of recs) {
      if (this.seenSeq.has(r.seq)) continue;
      this.seenSeq.add(r.seq);
      if (r.seq < runningMax) needsSort = true;
      else runningMax = r.seq;
      next.push(r);
      appended++;
    }
    if (appended === 0) return;
    if (needsSort) next.sort((a, b) => a.seq - b.seq);
    while (next.length > MAX_ENTRIES) {
      const removed = next.shift();
      if (removed) this.seenSeq.delete(removed.seq);
    }
    this.entries.set(next);
    if (this.autoScroll()) {
      queueMicrotask(() => this.scrollToBottom());
    }
  }

  private scrollToBottom(): void {
    cancelAnimationFrame(this.scrollToBottomRaf);
    this.scrollToBottomRaf = requestAnimationFrame(() => {
      const el = this.logViewport()?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
        this.scrollTopSig.set(el.scrollTop);
      }
      this.scheduleMeasureVisibleRows();
    });
  }

  protected onLogScroll(): void {
    cancelAnimationFrame(this.logScrollRaf);
    this.logScrollRaf = requestAnimationFrame(() => {
      const el = this.logViewport()?.nativeElement;
      if (!el) return;
      this.scrollTopSig.set(el.scrollTop);
      this.viewportHeightSig.set(el.clientHeight);
      this.scheduleMeasureVisibleRows();
    });
  }

  private scheduleMeasureVisibleRows(): void {
    if (this.measurePassScheduled) return;
    this.measurePassScheduled = true;
    afterNextRender(
      {
        read: () => {
          this.measurePassScheduled = false;
          const root = this.logViewport()?.nativeElement;
          if (!root) return;
          const rowsLen = this.filteredEntries().length;
          for (const wrap of root.querySelectorAll<HTMLElement>('[data-health-log-row]')) {
            const idx = Number(wrap.dataset['healthLogRow']);
            if (!Number.isFinite(idx) || idx < 0 || idx >= rowsLen) continue;
            const measured = wrap.offsetHeight;
            if (measured < 4) continue;
            this.rowHeights.update((arr) => {
              if (idx >= arr.length) return arr;
              if (Math.abs((arr[idx] ?? 0) - measured) < 2) return arr;
              const next = [...arr];
              next[idx] = measured;
              return next;
            });
          }
        },
      },
      { injector: this.inj },
    );
  }

  protected onAutoScrollToggle(): void {
    this.autoScroll.update((v) => !v);
    if (this.autoScroll()) this.scrollToBottom();
  }

  protected onLogExpandClick(): void {
    this.logExpandedToggle.emit();
  }

  protected formatTs(ms: number): string {
    const d = new Date(ms);
    const t = d.toLocaleTimeString(undefined, { hour12: false });
    const m = String(d.getMilliseconds()).padStart(3, '0');
    return `${t}.${m}`;
  }
}
