import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { DiffRow, DiffReviewStatus, FileDiffPayload } from '@shared/index';
import hljs from 'highlight.js';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ElectronService } from '../../../core/electron.service';
import { LucideAngularModule } from 'lucide-angular';
import { changeHunkOrderFromRows, rebuildFileWithAcceptedHunks } from '../diff-rebuild';

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
  },
})
export class DiffApplyComponent implements AfterViewInit, OnDestroy {
  readonly payload = input.required<FileDiffPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  private readonly electron = inject(ElectronService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly searchQuery = signal('');
  /** Full-screen overlay for the pending diff (toolbar “Expand”). */
  readonly diffExpanded = signal(false);
  readonly collapsedHunks = signal<Set<number>>(new Set());
  readonly applying = signal(false);
  readonly applyMessage = signal('');
  readonly stacked = signal(typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  readonly acceptedHunks = signal<Set<number>>(new Set());
  readonly skippedHunks = signal<Set<number>>(new Set());
  private agentContinueSent = false;
  private payloadEffectSig = '';

  readonly leftVp = viewChild<CdkVirtualScrollViewport>('leftVp');
  readonly rightVp = viewChild<CdkVirtualScrollViewport>('rightVp');

  private syncFrom: 'left' | 'right' | null = null;
  private highlightCache = new Map<string, SafeHtml>();
  private scrollWired = false;
  /** Invalidates in-flight scroll retries when a newer scroll is scheduled. */
  private scrollGeneration = 0;
  private lastPayloadSigForScroll = '';
  private readonly destroy$ = new Subject<void>();

  readonly changeHunkOrder = computed(() => changeHunkOrderFromRows(this.payload().rows));

  readonly incrementalOk = computed(() => !this.payload().truncated && this.payload().rows.length > 0);

  readonly currentFocusHunk = computed((): number | null => {
    const order = this.changeHunkOrder();
    const acc = this.acceptedHunks();
    const sk = this.skippedHunks();
    const next = order.find((h) => !acc.has(h) && !sk.has(h));
    return next ?? null;
  });

  readonly changeProgressLabel = computed(() => {
    const order = this.changeHunkOrder();
    if (order.length === 0) return '';
    const acc = this.acceptedHunks();
    const sk = this.skippedHunks();
    const done = order.filter((h) => acc.has(h) || sk.has(h)).length;
    const cur = this.currentFocusHunk();
    if (cur == null) {
      return `${done} / ${order.length} changes (done)`;
    }
    const at = order.indexOf(cur) + 1;
    return `Change ${at} of ${order.length} (${done} resolved)`;
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
      const p = this.payload();
      const sig = `${p.relativePath}|${p.baseSha256 ?? ''}|${p.rows.length}|${p.fullNewContent.length}`;
      if (sig !== this.payloadEffectSig) {
        this.payloadEffectSig = sig;
        this.acceptedHunks.set(new Set());
        this.skippedHunks.set(new Set());
        this.agentContinueSent = false;
        this.diffExpanded.set(false);
      }
    });

    effect(() => {
      if (this.reviewStatus() !== 'pending') {
        this.diffExpanded.set(false);
      }
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

    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(max-width: 900px)');
      mq.addEventListener('change', () => this.stacked.set(mq.matches));
    }
  }

  ngAfterViewInit(): void {
    const retry = (n: number) => {
      this.tryWireScrollSync();
      if (!this.scrollWired && n < 12) {
        setTimeout(() => retry(n + 1), 0);
      }
    };
    retry(0);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private scrollBothToListIndex(index: number): void {
    if (index < 0) return;
    this.leftVp()?.scrollToIndex(index);
    this.rightVp()?.scrollToIndex(index);
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
      left?.checkViewportSize();
      right?.checkViewportSize();
      this.scrollBothToListIndex(idx);
      const viable = h > 0;
      if (viable && attempts >= 2) return;
      if (attempts >= maxAttempts) return;
      requestAnimationFrame(step);
    };
    queueMicrotask(step);
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
      this.leftVp()?.checkViewportSize();
      this.rightVp()?.checkViewportSize();
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

  private async writeWorkspace(content: string): Promise<boolean> {
    const ws = await this.electron.getCurrentWorkspace();
    if (!ws?.path) {
      this.flashMessage('No workspace open.', 3000);
      return false;
    }
    const p = this.payload();
    const encoding = p.diskEncoding ?? 'utf-8';
    const newline = p.diskNewline === 'crlf' ? 'crlf' : 'lf';
    const res = await this.electron.writeWorkspaceFile(ws.path, p.relativePath, content, {
      encoding,
      newline,
    });
    if (!res.ok) {
      this.flashMessage(res.error ?? 'Write failed.', 4000);
      return false;
    }
    return true;
  }

  private async resumeAgent(note: string): Promise<boolean> {
    const id = this.conversationId();
    if (!id?.trim()) {
      this.flashMessage('No conversation id.', 3000);
      return false;
    }
    const res = await this.electron.notifyAgentContinue(id, note);
    if (!res.ok) {
      this.flashMessage(res.error ?? 'Could not resume assistant.', 5000);
      return false;
    }
    return true;
  }

  private async finishReview(status: 'complete' | 'cancelled', summary: string, note: string): Promise<void> {
    if (this.agentContinueSent) return;
    this.agentContinueSent = true;
    const ok = await this.resumeAgent(note);
    if (!ok) {
      this.agentContinueSent = false;
      return;
    }
    this.diffReviewFinished.emit({
      relativePath: this.payload().relativePath,
      status,
      summary,
    });
  }

  private async maybeCompleteReview(): Promise<void> {
    if (this.agentContinueSent) return;
    const order = this.changeHunkOrder();
    const acc = this.acceptedHunks();
    const sk = this.skippedHunks();
    if (!order.every((h) => acc.has(h) || sk.has(h))) return;

    const path = this.payload().relativePath;
    const allSkipped = order.length > 0 && order.every((h) => sk.has(h));

    let msg: string;
    let summary: string;
    if (allSkipped) {
      summary = 'All changes skipped';
      msg = [
        'The user skipped all proposed edits for file',
        `\`${path}\`.`,
        'Please continue from here.',
      ].join(' ');
    } else {
      summary = 'Complete';
      msg = [
        'I finished reviewing the proposed edit for file',
        `\`${path}\`.`,
        'The workspace file on disk reflects the accepted changes. Please continue from here.',
      ].join(' ');
    }
    this.flashMessage('Review complete. Resuming assistant…', 3500);
    await this.finishReview('complete', summary, msg);
  }

  async acceptCurrentChange(): Promise<void> {
    if (this.applying()) return;
    const order = this.changeHunkOrder();
    const focus = this.currentFocusHunk();
    if (!this.incrementalOk()) {
      await this.applyAllAtOnce();
      return;
    }
    if (focus == null) {
      await this.applyAllAtOnce();
      return;
    }

    this.applying.set(true);
    this.applyMessage.set('');
    try {
      const next = new Set(this.acceptedHunks());
      next.add(focus);
      const body = rebuildFileWithAcceptedHunks(this.payload().rows, next);
      const ok = await this.writeWorkspace(body);
      if (!ok) return;

      this.acceptedHunks.set(next);

      const sk = this.skippedHunks();
      const allResolved = order.every((h) => next.has(h) || sk.has(h));
      if (allResolved) {
        const p = this.payload();
        const allSk = order.every((h) => sk.has(h));
        if (!allSk && body !== p.fullNewContent) {
          const fix = await this.writeWorkspace(p.fullNewContent);
          if (!fix) return;
        }
        await this.maybeCompleteReview();
      } else {
        this.flashMessage('Saved. Next change highlighted.', 2200);
      }
    } finally {
      this.applying.set(false);
    }
  }

  async skipCurrentChange(): Promise<void> {
    if (this.applying()) return;
    const order = this.changeHunkOrder();
    const focus = this.currentFocusHunk();
    if (!this.incrementalOk() || focus == null) return;

    this.applying.set(true);
    this.applyMessage.set('');
    try {
      const sk = new Set(this.skippedHunks());
      sk.add(focus);
      this.skippedHunks.set(sk);

      const acc = this.acceptedHunks();
      const body = rebuildFileWithAcceptedHunks(this.payload().rows, acc);
      const ok = await this.writeWorkspace(body);
      if (!ok) {
        sk.delete(focus);
        this.skippedHunks.set(sk);
        return;
      }

      const allResolved = order.every((h) => acc.has(h) || sk.has(h));
      if (allResolved) {
        const p = this.payload();
        const allSk = order.every((h) => sk.has(h));
        if (!allSk && body !== p.fullNewContent) {
          const fix = await this.writeWorkspace(p.fullNewContent);
          if (!fix) return;
        }
        await this.maybeCompleteReview();
      } else {
        this.flashMessage('Skipped. Next change highlighted.', 2200);
      }
    } finally {
      this.applying.set(false);
    }
  }

  async applyAllAtOnce(): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    this.applyMessage.set('');
    try {
      const ok = await this.writeWorkspace(this.payload().fullNewContent);
      if (!ok) return;
      const order = this.changeHunkOrder();
      this.acceptedHunks.set(new Set(order));
      this.skippedHunks.set(new Set());
      await this.maybeCompleteReview();
    } finally {
      this.applying.set(false);
    }
  }

  async cancelProposal(): Promise<void> {
    if (this.applying() || this.agentContinueSent) return;
    const path = this.payload().relativePath;
    const msg = [
      'The user cancelled applying the proposed edits for file',
      `\`${path}\`.`,
      'Those edits were not applied. Please continue from here.',
    ].join(' ');
    this.flashMessage('Cancelled. Resuming assistant…', 3500);
    await this.finishReview('cancelled', 'Cancelled', msg);
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
