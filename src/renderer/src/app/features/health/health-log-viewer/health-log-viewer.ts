import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import type { AppConfig, HealthLogLevel, HealthLogRecord } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HealthLogMessagePipe, type HealthLogMessageFormat } from './health-log-message.pipe';

const MAX_ENTRIES = 2500;

@Component({
  selector: 'app-health-log-viewer',
  imports: [FormsModule, HealthLogMessagePipe],
  templateUrl: './health-log-viewer.html',
  styleUrl: './health-log-viewer.css',
})
export class HealthLogViewer implements OnInit, OnDestroy {
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

  constructor(private electron: ElectronService) {}

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
    this.sub?.unsubscribe();
    this.configSub?.unsubscribe();
    if (this.electron.isElectron) {
      this.electron.healthLogsUnsubscribe();
    }
  }

  protected async onVerbosityChange(level: HealthLogLevel): Promise<void> {
    this.logVerbosity.set(level);
    const cfg = await this.electron.loadConfig();
    const next: AppConfig = { ...cfg, healthMonitor: { ...cfg.healthMonitor, logLevel: level } };
    await this.electron.saveConfig(next);
    await this.electron.healthSetLogLevel(level);
  }

  private mergeRecords(recs: HealthLogRecord[]): void {
    if (recs.length === 0) return;
    const cur = this.entries();
    const next = [...cur];
    for (const r of recs) {
      if (this.seenSeq.has(r.seq)) continue;
      this.seenSeq.add(r.seq);
      next.push(r);
    }
    next.sort((a, b) => a.seq - b.seq);
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
    const el = this.logViewport()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
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
