import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  Injector,
  OnDestroy,
  ViewEncapsulation,
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
import type { DiffReviewStatus, StagedTransferBatchPayload, StagedTransferFileResolution } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { DiffApplyComponent } from '../diff-apply/diff-apply';
import {
  PendingDiffReviewService,
  type BatchFinishFn,
  type BatchPartialFn,
  type FlashFn,
} from '../pending-diff-review.service';

@Component({
  selector: 'app-staged-transfer-batch-review',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DiffApplyComponent],
  templateUrl: './staged-transfer-batch-review.html',
  styleUrl: './staged-transfer-batch-review.css',
  encapsulation: ViewEncapsulation.None,
})
export class StagedTransferBatchReviewComponent implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly doc = inject(DOCUMENT);
  private readonly inj = inject(Injector);

  readonly payload = input.required<StagedTransferBatchPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);
  readonly fileResolutions = input<Record<string, StagedTransferFileResolution>>({});
  /** When true (HITL panel expanded), use taller inline diff panes; fullscreen stays opt-in via Expand. */
  readonly preferFullscreen = input(false);

  readonly batchReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, StagedTransferFileResolution>;
  }>();
  readonly batchFileResolved = output<{
    requestId: string;
    fileResolutions: Record<string, StagedTransferFileResolution>;
  }>();

  private readonly pendingDiff = inject(PendingDiffReviewService);

  readonly reReviewFeedback = signal('');
  /** Notes composer visibility — opens from “Request changes”, closes on send / keep reviewing. */
  readonly feedbackOpen = signal(false);
  readonly applyMessage = signal('');
  /** Full-window review for the whole batch (toolbar + diff panes). */
  readonly batchExpanded = signal(false);

  private readonly expandShellRef = viewChild<ElementRef<HTMLElement>>('expandShell');
  private readonly feedbackInputRef = viewChild<ElementRef<HTMLTextAreaElement>>('feedbackInput');
  private portalRestoreParent: HTMLElement | null = null;

  private readonly session = computed(() => this.pendingDiff.batchSessionFor(this.payload()));

  readonly mergedResolutions = computed((): Record<string, StagedTransferFileResolution> => ({
    ...this.fileResolutions(),
    ...this.session().resolutions(),
  }));

  readonly currentFileIndex = computed(() => this.session().currentFileIndex());

  readonly currentFile = computed(() => {
    const files = this.payload().files;
    const idx = Math.min(Math.max(this.currentFileIndex(), 0), Math.max(files.length - 1, 0));
    return files[idx] ?? files[0];
  });

  readonly fileProgressLabel = computed(() => {
    const total = this.payload().files.length;
    const idx = Math.min(Math.max(this.currentFileIndex(), 0), Math.max(total - 1, 0));
    return `File ${idx + 1} of ${total}`;
  });

  readonly batchTitle = computed(() =>
    this.payload().untransferredFlush ? 'Left untransferred' : 'Staged batch',
  );

  readonly currentFileName = computed(() => {
    const rel = this.currentFile().relativePath.replace(/\\/g, '/');
    const slash = rel.lastIndexOf('/');
    return slash >= 0 ? rel.slice(slash + 1) : rel;
  });

  readonly fileCountLabel = computed(() => {
    const n = this.payload().files.length;
    return n === 1 ? '1 file' : `${n} files`;
  });

  /** `2 approved · 1 sent back`, for the collapsed card and the file strip. */
  readonly outcomeSummary = computed(() => {
    const resolutions = this.mergedResolutions();
    let approved = 0;
    let sentBack = 0;
    for (const file of this.payload().files) {
      const res = resolutions[file.relativePath] ?? 'pending';
      if (res === 'approved') {
        approved += 1;
      } else if (res === 're_review') {
        sentBack += 1;
      }
    }
    const parts: string[] = [];
    if (approved > 0) {
      parts.push(`${approved} approved`);
    }
    if (sentBack > 0) {
      parts.push(`${sentBack} sent back`);
    }
    return parts.join(' · ');
  });

  readonly remainingLabel = computed(() => {
    const resolutions = this.mergedResolutions();
    const left = this.payload().files.filter(
      (f) => (resolutions[f.relativePath] ?? 'pending') === 'pending',
    ).length;
    if (left === 0) {
      return 'all files reviewed';
    }
    return left === 1 ? '1 file left' : `${left} files left`;
  });

  /** Notes this user already sent with the current file (empty when none were typed). */
  readonly submittedFeedback = computed(
    () => this.session().feedbackByPath()[this.currentFile().relativePath] ?? '',
  );

  readonly resolutionHeadline = computed(() =>
    this.currentFileResolved() === 'approved' ? 'Saved to disk' : 'Sent back for changes',
  );

  readonly resolutionHint = computed(() =>
    this.currentFileResolved() === 'approved'
      ? 'The workspace file now holds this draft.'
      : 'Nothing was written for this file.',
  );

  tabTitle(relativePath: string): string {
    switch (this.fileResolution(relativePath)) {
      case 'approved':
        return `${relativePath} — saved to disk`;
      case 're_review':
        return `${relativePath} — sent back for changes`;
      default:
        return `${relativePath} — waiting for review`;
    }
  }

  constructor() {
    effect(() => {
      if (this.batchComplete()) {
        this.batchExpanded.set(false);
      }
    });

    effect(() => {
      if (this.reviewStatus() !== 'pending') {
        return;
      }
      const p = this.payload();
      const resolutions = this.mergedResolutions();
      const next = this.pendingDiff.nextUnresolvedFileIndex(p, resolutions);
      this.session().currentFileIndex.set(next);
    });

    effect(() => {
      const portalActive = this.batchExpanded() && !this.batchComplete();
      untracked(() => {
        afterNextRender(() => this.syncExpandPortal(portalActive), { injector: this.inj });
      });
    });
  }

  ngOnDestroy(): void {
    this.restoreExpandPortal();
  }

  /** Move fullscreen shell to document.body so position:fixed spans the whole window. */
  private syncExpandPortal(active: boolean): void {
    const shell = this.expandShellRef()?.nativeElement;
    if (!shell) {
      return;
    }
    if (active) {
      if (shell.parentElement === this.doc.body) {
        return;
      }
      this.portalRestoreParent = shell.parentElement;
      this.doc.body.appendChild(shell);
      this.doc.body.style.overflow = 'hidden';
      return;
    }
    this.restoreExpandPortal();
  }

  private restoreExpandPortal(): void {
    const shell = this.expandShellRef()?.nativeElement;
    if (!shell || shell.parentElement !== this.doc.body) {
      return;
    }
    const parent = this.portalRestoreParent ?? this.host.nativeElement;
    parent.appendChild(shell);
    this.portalRestoreParent = null;
    if (!this.doc.body.querySelector('.staged-batch-expand-shell--active')) {
      this.doc.body.style.overflow = '';
    }
  }

  readonly currentFileResolved = computed((): StagedTransferFileResolution => {
    const rel = this.currentFile().relativePath;
    return this.fileResolution(rel);
  });

  /** Record indexing is typed as always-present; treat missing keys as pending at runtime. */
  fileResolution(relativePath: string): StagedTransferFileResolution {
    const value = this.mergedResolutions()[relativePath] as StagedTransferFileResolution | undefined;
    return value ?? 'pending';
  }

  isFileResolved(relativePath: string): boolean {
    return this.fileResolution(relativePath) !== 'pending';
  }

  readonly applying = computed(() => {
    const path = this.session().applyingPath();
    return !!path && path === this.currentFile().relativePath;
  });

  readonly batchComplete = computed(() => this.reviewStatus() !== 'pending');

  private flash(message: string, ms: number): void {
    this.applyMessage.set(message);
    setTimeout(() => this.applyMessage.set(''), ms);
  }

  toggleBatchExpanded(): void {
    this.batchExpanded.update((v) => !v);
    this.schedulePortalSync();
  }

  collapseBatchExpanded(): void {
    this.batchExpanded.set(false);
    this.schedulePortalSync();
  }

  private schedulePortalSync(): void {
    const active = this.batchExpanded() && !this.batchComplete();
    afterNextRender(() => {
      this.syncExpandPortal(active);
      if (active && this.expandShellRef()?.nativeElement?.parentElement !== this.doc.body) {
        setTimeout(() => this.syncExpandPortal(active), 0);
      }
    }, { injector: this.inj });
  }

  /** Escape unwinds one layer at a time: notes composer first, then the full-window view. */
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') {
      return;
    }
    if (this.feedbackOpen()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.closeFeedback();
      return;
    }
    if (!this.batchExpanded()) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.collapseBatchExpanded();
  }

  openFeedback(): void {
    this.feedbackOpen.set(true);
    afterNextRender(() => this.feedbackInputRef()?.nativeElement?.focus(), { injector: this.inj });
  }

  closeFeedback(): void {
    this.feedbackOpen.set(false);
    this.reReviewFeedback.set('');
  }

  goPrev(): void {
    const idx = this.session().currentFileIndex();
    if (idx > 0) {
      this.closeFeedback();
      this.session().currentFileIndex.set(idx - 1);
    }
  }

  goNext(): void {
    const files = this.payload().files;
    const idx = this.session().currentFileIndex();
    if (idx < files.length - 1) {
      this.closeFeedback();
      this.session().currentFileIndex.set(idx + 1);
    }
  }

  selectFile(index: number): void {
    const files = this.payload().files;
    if (index >= 0 && index < files.length) {
      this.closeFeedback();
      this.session().currentFileIndex.set(index);
    }
  }

  async approveCurrentFile(): Promise<void> {
    const file = this.currentFile();
    if (!file || this.currentFileResolved() !== 'pending') {
      return;
    }
    this.closeFeedback();
    await this.pendingDiff.resolveStagedTransferBatchFile(
      this.payload(),
      file.relativePath,
      'confirm',
      '',
      this.conversationId(),
      this.flash.bind(this) as FlashFn,
      this.onBatchFinished,
      this.onPartialResolved,
    );
  }

  async returnCurrentForReReview(): Promise<void> {
    const file = this.currentFile();
    if (!file || this.currentFileResolved() !== 'pending') {
      return;
    }
    await this.pendingDiff.resolveStagedTransferBatchFile(
      this.payload(),
      file.relativePath,
      're_review',
      this.reReviewFeedback(),
      this.conversationId(),
      this.flash.bind(this) as FlashFn,
      this.onBatchFinished,
      this.onPartialResolved,
    );
    this.closeFeedback();
  }

  private readonly onBatchFinished: BatchFinishFn = (event) => {
    this.batchReviewFinished.emit(event);
  };

  private readonly onPartialResolved: BatchPartialFn = (event) => {
    this.batchFileResolved.emit(event);
  };
}
