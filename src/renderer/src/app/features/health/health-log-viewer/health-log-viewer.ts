import {
  Component,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  signal,
  viewChild,
  ElementRef,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { Subscription } from 'rxjs';
import type { AppConfig, HealthLogLevel, HealthLogRecord } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HealthLogMessagePipe, type HealthLogMessageFormat } from './health-log-message.pipe';
import { estimateHealthLogRowHeight, healthLogVirtualWindow } from './health-log-virtual';
import {
  HEALTH_LOG_BUCKETS,
  countHealthLogBuckets,
  healthLogBucket,
  type HealthLogBucket,
} from './health-log-levels';

const MAX_ENTRIES = 2500;

@Component({
  selector: 'app-health-log-viewer',
  imports: [FormsModule, LucideAngularModule, HealthLogMessagePipe, PillSelectComponent],
  templateUrl: './health-log-viewer.html',
  styleUrls: ['../shared/health-tone.css', './health-log-viewer.css'],
})
export class HealthLogViewer implements OnInit, OnDestroy {
  private readonly inj = inject(Injector);

  protected readonly searchQuery = signal('');
  /** Live mode follows new rows; scrolling up pauses it until the user resumes or returns to the bottom. */
  protected readonly autoScroll = signal(true);
  protected readonly newWhilePaused = signal(0);
  protected readonly hiddenLevels = signal<ReadonlySet<HealthLogBucket>>(new Set());
  protected readonly buckets = HEALTH_LOG_BUCKETS;
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

  protected readonly levelCounts = computed(() => countHealthLogBuckets(this.entries()));

  protected readonly filteredEntries = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const hidden = this.hiddenLevels();

    return this.entries().filter((e) => {
      if (hidden.size > 0 && hidden.has(healthLogBucket(e.level))) return false;
      if (!q) return true;
      const hay = `${e.logger} ${e.message} ${e.source}`.toLowerCase();
      return hay.includes(q);
    });
  });

  protected readonly filterKey = computed(
    () => `${[...this.hiddenLevels()].sort().join(',')}\0${this.searchQuery().trim().toLowerCase()}`,
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
          const wasHidden = this.viewportHeightSig() === 0;
          this.viewportHeightSig.set(el.clientHeight);
          // The console tab stays mounted while hidden; jump back to the tail when it is shown again.
          if (wasHidden && el.clientHeight > 0 && this.autoScroll()) this.scrollToBottom();
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
    } else {
      this.newWhilePaused.update((n) => n + appended);
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
      if (!this.autoScroll() && el.scrollHeight - el.scrollTop - el.clientHeight <= 4) {
        this.resumeLive();
      }
      this.scheduleMeasureVisibleRows();
    });
  }

  /** Wheel-up and paging keys mean the user is reading history: stop following the tail. */
  protected onLogWheel(event: WheelEvent): void {
    if (event.deltaY < 0) this.pauseLive();
  }

  protected onLogKeydown(event: KeyboardEvent): void {
    if (event.key === 'PageUp' || event.key === 'Home' || event.key === 'ArrowUp') this.pauseLive();
  }

  private pauseLive(): void {
    if (!this.autoScroll()) return;
    this.autoScroll.set(false);
    this.newWhilePaused.set(0);
  }

  private resumeLive(): void {
    this.autoScroll.set(true);
    this.newWhilePaused.set(0);
    this.scrollToBottom();
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

  protected onLiveClick(): void {
    if (this.autoScroll()) this.pauseLive();
    else this.resumeLive();
  }

  protected toggleLevel(bucket: HealthLogBucket): void {
    this.hiddenLevels.update((cur) => {
      const next = new Set(cur);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }

  protected levelTone(bucket: HealthLogBucket): string {
    if (bucket === 'ERROR') return 'error';
    if (bucket === 'WARNING') return 'warn';
    if (bucket === 'INFO') return 'info';
    return 'debug';
  }

  protected levelLabel(bucket: HealthLogBucket): string {
    return bucket === 'WARNING' ? 'Warnings' : bucket === 'ERROR' ? 'Errors' : bucket === 'INFO' ? 'Info' : 'Debug';
  }

  protected formatTs(ms: number): string {
    const d = new Date(ms);
    const t = d.toLocaleTimeString(undefined, { hour12: false });
    const m = String(d.getMilliseconds()).padStart(3, '0');
    return `${t}.${m}`;
  }
}
