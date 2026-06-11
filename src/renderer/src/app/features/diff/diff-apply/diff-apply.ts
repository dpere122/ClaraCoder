import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  HostListener,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { DiffRow, DiffReviewStatus, FileDiffPayload } from '@shared/index';
import hljs from 'highlight.js';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { LucideAngularModule } from 'lucide-angular';
import { PendingDiffReviewService } from '../pending-diff-review.service';

type DiffListItem = { t: 'h'; hunkIndex: number } | { t: 'r'; row: DiffRow };

@Component({
  selector: 'app-diff-apply',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, LucideAngularModule],
  templateUrl: './diff-apply.html',
  styleUrl: './diff-apply.css',
  host: {
    tabindex: '0',
    class: 'diff-apply-host',
    '[class.diff-apply-host--expanded]': 'diffExpanded()',
    '[class.diff-apply-host--batch-expand]': 'embeddedInBatchExpand()',
    '[class.diff-apply-host--hitl-expand]': 'embeddedInHitlExpand()',
  },
})
export class DiffApplyComponent implements AfterViewInit, OnDestroy {
  readonly payload = input.required<FileDiffPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);
  /** When true, hide staged-transfer approve/re-review (parent batch card owns those actions). */
  readonly suppressStagedTransferActions = input(false);
  /** When true, hide the toolbar Expand control (parent batch card owns fullscreen expand). */
  readonly hideExpandButton = input(false);
  /** When true, stretch diff panes for a parent batch fullscreen shell. */
  readonly embeddedInBatchExpand = input(false);
  /** When true, use taller inline panes inside an expanded HITL trail (not fullscreen). */
  readonly embeddedInHitlExpand = input(false);

  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  private readonly sanitizer = inject(DomSanitizer);
  private readonly pendingDiff = inject(PendingDiffReviewService);
  private readonly inj = inject(Injector);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly searchQuery = signal('');
  /** Filter input visibility — collapsed by default to keep the toolbar compact. */
  readonly filterOpen = signal(false);
  /** Re-review notes textarea visibility — collapsed by default. */
  readonly feedbackOpen = signal(false);
  /** Full-screen overlay for the pending diff (toolbar “Expand”). */
  readonly diffExpanded = signal(false);
  readonly collapsedHunks = signal<Set<number>>(new Set());
  readonly applyMessage = signal('');
  readonly stacked = signal(typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);

  /** Shared with Monaco: same proposal identity shares accept/skip progress. */
  private readonly session = computed(() => this.pendingDiff.sessionFor(this.payload()));
  readonly acceptedHunks = computed(() => this.session().accepted());
  readonly skippedHunks = computed(() => this.session().skipped());
  readonly applying = computed(() => this.session().applying());

  readonly leftVp = viewChild<CdkVirtualScrollViewport>('leftVp');
  readonly rightVp = viewChild<CdkVirtualScrollViewport>('rightVp');

  private syncFrom: 'left' | 'right' | null = null;
  private highlightCache = new Map<string, SafeHtml>();
  private scrollWired = false;
  private viewportResizeObserver: ResizeObserver | null = null;
  private viewportResizeObserved = false;
  /** Invalidates in-flight scroll retries when a newer scroll is scheduled. */
  private scrollGeneration = 0;
  private lastPayloadSigForScroll = '';
  private lastPayloadKeyForExpand = '';
  private readonly destroy$ = new Subject<void>();
  private stackedMediaQuery: MediaQueryList | null = null;
  private readonly onStackedMediaChange = (): void => {
    if (this.stackedMediaQuery) {
      this.stacked.set(this.stackedMediaQuery.matches);
    }
  };

  readonly changeHunkOrder = computed(() => this.pendingDiff.changeHunkOrder(this.payload()));

  /** Code-review staged file awaiting human gate before writing the real workspace. */
  readonly isStagedTransferHitl = computed(
    () => !!this.payload().stagedTransferHitl && !this.suppressStagedTransferActions(),
  );

  readonly incrementalOk = computed(() => this.pendingDiff.incrementalOk(this.payload()));

  /** Optional feedback when returning a staged transfer to the review / writer path. */
  readonly reReviewFeedback = signal('');

  readonly currentFocusHunk = computed((): number | null =>
    this.pendingDiff.currentFocusHunk(this.payload(), this.acceptedHunks(), this.skippedHunks()),
  );

  readonly changeProgressLabel = computed(() => {
    const order = this.changeHunkOrder();
    if (order.length === 0) return '';
    const acc = this.acceptedHunks();
    const sk = this.skippedHunks();
    const done = order.filter((h) => acc.has(h) || sk.has(h)).length;
    const cur = this.currentFocusHunk();
    if (cur == null) {
      return `${done}/${order.length}`;
    }
    const at = order.indexOf(cur) + 1;
    return `${at}/${order.length}`;
  });

  readonly baseRows = computed(() => {
    const p = this.payload();
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return p.rows;
    return p.rows.filter(
      (r) => r.leftText.toLowerCase().includes(q) || r.rightText.toLowerCase().includes(q),
    );
  });

  readonly listItems = computed((): DiffListItem[] => {
    const rows = this.baseRows();
    const collapsed = this.collapsedHunks();
    const items: DiffListItem[] = [];
    let lastHunk = -9999;
    for (const row of rows) {
      if (row.hunkIndex !== lastHunk) {
        items.push({ t: 'h', hunkIndex: row.hunkIndex });
        lastHunk = row.hunkIndex;
      }
      if (!collapsed.has(row.hunkIndex)) {
        items.push({ t: 'r', row });
      }
    }
    return items;
  });

  constructor() {
    effect(() => {
      this.payload();
      this.searchQuery();
      this.collapsedHunks();
      this.highlightCache.clear();
    });

    effect(() => {
      const key = this.pendingDiff.sessionKey(this.payload());
      if (key !== this.lastPayloadKeyForExpand) {
        this.lastPayloadKeyForExpand = key;
        this.diffExpanded.set(false);
      }
    });

    effect(() => {
      if (this.reviewStatus() !== 'pending') {
        this.diffExpanded.set(false);
      }
    });

    effect(() => {
      if (!this.embeddedInBatchExpand() && !this.embeddedInHitlExpand()) {
        return;
      }
      const gen = ++this.scrollGeneration;
      requestAnimationFrame(() => {
        if (gen !== this.scrollGeneration) return;
        this.refreshVirtualScrollViewports();
        requestAnimationFrame(() => {
          if (gen !== this.scrollGeneration) return;
          this.scheduleScrollWithRetry(() => this.firstDiffIndexInHunk(this.currentFocusHunk()), gen);
        });
      });
    });

    effect(() => {
      const hunk = this.currentFocusHunk();
      if (hunk != null) {
        this.collapsedHunks.update((s) => {
          const n = new Set(s);
          n.delete(hunk);
          return n;
        });
      }
    });

    effect(() => {
      const p = this.payload();
      const sig = `${p.relativePath}|${p.baseSha256 ?? ''}|${p.rows.length}|${p.fullNewContent.length}`;
      this.currentFocusHunk();
      const sigChanged = sig !== this.lastPayloadSigForScroll;
      this.lastPayloadSigForScroll = sig;
      const gen = ++this.scrollGeneration;
      queueMicrotask(() => {
        if (gen !== this.scrollGeneration) return;
        const resolver = sigChanged
          ? () => this.firstGlobalChangeListIndex()
          : () => this.firstDiffIndexInHunk(this.currentFocusHunk());
        this.scheduleScrollWithRetry(resolver, gen);
      });
    });

    effect(() => {
      if (this.reviewStatus() !== 'pending') {
        return;
      }
      this.leftVp();
      this.rightVp();
      this.listItems();
      untracked(() => {
        afterNextRender(
          () => {
            this.refreshVirtualScrollViewports();
            this.ensureViewportResizeObserver();
          },
          { injector: this.inj },
        );
      });
    });

    if (typeof window !== 'undefined') {
      this.stackedMediaQuery = window.matchMedia('(max-width: 900px)');
      this.stackedMediaQuery.addEventListener('change', this.onStackedMediaChange);
    }
  }

  ngAfterViewInit(): void {
    const retry = (n: number) => {
      this.tryWireScrollSync();
      this.ensureViewportResizeObserver();
      this.refreshVirtualScrollViewports();
      if ((!this.scrollWired || !this.viewportResizeObserved) && n < 12) {
        setTimeout(() => retry(n + 1), 0);
      }
    };
    retry(0);
  }

  ngOnDestroy(): void {
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.viewportResizeObserved = false;
    this.stackedMediaQuery?.removeEventListener('change', this.onStackedMediaChange);
    this.stackedMediaQuery = null;
    this.destroy$.next();
    this.destroy$.complete();
  }

  private scrollBothToListIndex(index: number): void {
    if (index < 0) return;
    this.leftVp()?.scrollToIndex(index);
    this.rightVp()?.scrollToIndex(index);
  }

  private refreshVirtualScrollViewports(): void {
    this.leftVp()?.checkViewportSize();
    this.rightVp()?.checkViewportSize();
    // Zoneless: this often runs from rAF/timeout callbacks, which schedule no
    // change detection on their own — request a tick so the rows actually paint.
    this.cdr.markForCheck();
  }

  private ensureViewportResizeObserver(): void {
    if (this.viewportResizeObserved || typeof ResizeObserver === 'undefined') {
      return;
    }
    const left = this.leftVp();
    const right = this.rightVp();
    if (!left || !right) {
      return;
    }
    this.viewportResizeObserved = true;
    this.viewportResizeObserver = new ResizeObserver(() => {
      this.refreshVirtualScrollViewports();
    });
    this.viewportResizeObserver.observe(left.getElementRef().nativeElement);
    this.viewportResizeObserver.observe(right.getElementRef().nativeElement);
    this.refreshVirtualScrollViewports();
  }

  private firstGlobalChangeListIndex(): number {
    const items = this.listItems();
    let idx = items.findIndex((it) => it.t === 'r' && it.row.kind !== 'equal');
    if (idx < 0) {
      idx = items.findIndex((it) => it.t === 'r');
    }
    return idx < 0 ? 0 : idx;
  }

  private firstDiffIndexInHunk(hunk: number | null): number {
    if (hunk == null) return -1;
    const items = this.listItems();
    let idx = items.findIndex(
      (it) => it.t === 'r' && it.row.hunkIndex === hunk && it.row.kind !== 'equal',
    );
    if (idx < 0) {
      idx = items.findIndex((it) => it.t === 'r' && it.row.hunkIndex === hunk);
    }
    return idx;
  }

  private scheduleScrollWithRetry(resolveIndex: () => number, gen: number): void {
    let attempts = 0;
    const maxAttempts = 24;
    const step = () => {
      if (gen !== this.scrollGeneration) return;
      attempts++;
      const left = this.leftVp();
      const right = this.rightVp();
      const el = left?.getElementRef().nativeElement;
      const h = el?.clientHeight ?? 0;
      const idx = resolveIndex();
      if (idx < 0) return;
      this.refreshVirtualScrollViewports();
      this.scrollBothToListIndex(idx);
      const viable = h > 0;
      if (viable && attempts >= 2) return;
      if (attempts >= maxAttempts) return;
      requestAnimationFrame(step);
    };
    queueMicrotask(step);
  }

  toggleFilter(): void {
    const next = !this.filterOpen();
    this.filterOpen.set(next);
    if (!next) {
      this.searchQuery.set('');
    }
  }

  collapseDiffExpanded(): void {
    this.diffExpanded.set(false);
  }

  toggleDiffExpanded(): void {
    const next = !this.diffExpanded();
    this.diffExpanded.set(next);
    if (!next) return;
    const gen = ++this.scrollGeneration;
    requestAnimationFrame(() => {
      if (gen !== this.scrollGeneration) return;
      this.refreshVirtualScrollViewports();
      requestAnimationFrame(() => {
        if (gen !== this.scrollGeneration) return;
        this.scheduleScrollWithRetry(() => this.firstDiffIndexInHunk(this.currentFocusHunk()), gen);
      });
    });
  }

  private tryWireScrollSync(): void {
    if (this.scrollWired) return;
    const left = this.leftVp();
    const right = this.rightVp();
    if (!left || !right) return;
    this.scrollWired = true;

    left
      .elementScrolled()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.syncFrom === 'right') return;
        this.syncFrom = 'left';
        const y = left.measureScrollOffset('top');
        right.scrollToOffset(y);
        requestAnimationFrame(() => {
          this.syncFrom = null;
        });
      });

    right
      .elementScrolled()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.syncFrom === 'left') return;
        this.syncFrom = 'right';
        const y = right.measureScrollOffset('top');
        left.scrollToOffset(y);
        requestAnimationFrame(() => {
          this.syncFrom = null;
        });
      });
  }

  readonly itemSize = 28;

  trackByIndex(i: number, item: DiffListItem): string {
    return item.t === 'h' ? `h-${item.hunkIndex}-${i}` : `r-${i}-${item.row.leftLine}-${item.row.rightLine}-${item.row.kind}`;
  }

  hunkCollapsed(hunkIndex: number): boolean {
    return this.collapsedHunks().has(hunkIndex);
  }

  toggleHunk(hunkIndex: number): void {
    this.collapsedHunks.update((s) => {
      const next = new Set(s);
      if (next.has(hunkIndex)) next.delete(hunkIndex);
      else next.add(hunkIndex);
      return next;
    });
  }

  hunkAccepted(hunkIndex: number): boolean {
    return this.acceptedHunks().has(hunkIndex);
  }

  rowClass(kind: string): string {
    return `diff-row diff-row--${kind}`;
  }

  highlight(text: string): SafeHtml {
    if (!text) {
      return this.sanitizer.bypassSecurityTrustHtml('&nbsp;');
    }
    const lang = this.payload().language;
    const key = `${lang}:${text}`;
    const hit = this.highlightCache.get(key);
    if (hit) return hit;
    let html: string;
    try {
      if (lang && hljs.getLanguage(lang)) {
        html = hljs.highlight(text, { language: lang }).value;
      } else {
        html = hljs.highlightAuto(text).value;
      }
    } catch {
      html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const safe = this.sanitizer.bypassSecurityTrustHtml(html);
    this.highlightCache.set(key, safe);
    return safe;
  }

  async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.flashMessage('Copied', 1500);
    } catch {
      this.flashMessage('Copy failed', 2000);
    }
  }

  private flashMessage(msg: string, ms: number): void {
    this.applyMessage.set(msg);
    setTimeout(() => this.applyMessage.set(''), ms);
  }

  async copyHunk(hunkIndex: number): Promise<void> {
    const lines = this.payload().rows.filter((r) => r.hunkIndex === hunkIndex);
    const text = lines.map((r) => `-${r.leftText}\n+${r.rightText}`).join('\n');
    await this.copyText(text);
  }

  private readonly finishEmit = (e: {
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void => {
    this.diffReviewFinished.emit(e);
  };

  async acceptCurrentChange(): Promise<void> {
    await this.pendingDiff.acceptCurrentChange(
      this.payload(),
      this.conversationId(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  async skipCurrentChange(): Promise<void> {
    await this.pendingDiff.skipCurrentChange(
      this.payload(),
      this.conversationId(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  async approveStagedTransferHitl(): Promise<void> {
    await this.pendingDiff.approveStagedTransferHitl(
      this.payload(),
      this.conversationId(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  async returnStagedTransferForReReview(): Promise<void> {
    await this.pendingDiff.returnStagedTransferForReReview(
      this.payload(),
      this.conversationId(),
      this.reReviewFeedback(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  async applyAllAtOnce(): Promise<void> {
    await this.pendingDiff.applyAllAtOnce(
      this.payload(),
      this.conversationId(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  async cancelProposal(): Promise<void> {
    await this.pendingDiff.cancelProposal(
      this.payload(),
      this.conversationId(),
      (msg, ms) => this.flashMessage(msg, ms),
      this.finishEmit,
    );
  }

  @HostListener('keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.diffExpanded()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.collapseDiffExpanded();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      void this.acceptCurrentChange();
    }
  }
}
