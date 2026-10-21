import { CommonModule } from '@angular/common';
import { Component, effect, inject, Injector, input, OnDestroy, output, signal, untracked } from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { DeleteConfirmEntry, DeleteConfirmPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HITL_BTN_SPINNER_TYPE, newHitlBtnSpinnerName, scheduleHitlBtnSpinner } from '../../chat/hitl-btn-spinner';

@Component({
  selector: 'app-delete-confirm',
  standalone: true,
  imports: [CommonModule, NgxSpinnerComponent],
  templateUrl: './delete-confirm.html',
  styleUrl: './delete-confirm.css',
})
export class DeleteConfirmComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  readonly payload = input.required<DeleteConfirmPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  readonly busySpinnerName = newHitlBtnSpinnerName('delete');
  readonly busySpinnerType = HITL_BTN_SPINNER_TYPE;
  private continueSent = false;

  constructor() {
    effect(() => {
      const loading = this.busy();
      untracked(() => scheduleHitlBtnSpinner(this.ngxSpinner, this.busySpinnerName, loading, this.inj));
    });
  }

  ngOnDestroy(): void {
    void this.ngxSpinner.hide(this.busySpinnerName);
  }

  /** A sub-agent's card (shown in its parent's dock) resumes the sub-agent's session. */
  private targetSessionId(): string | null {
    return this.payload().subagent?.conversationId ?? this.conversationId();
  }

  resolvedEntries(): DeleteConfirmEntry[] {
    const p = this.payload();
    if (p.entries?.length) {
      return p.entries;
    }
    const rp = p.relativePath;
    const k = p.kind;
    const r = p.recursive;
    if (rp && k !== undefined && r !== undefined) {
      return [{ relativePath: rp, kind: k, recursive: r }];
    }
    return [];
  }

  deleteCountLabel(): string {
    const n = this.resolvedEntries().length;
    return n === 1 ? '1 path' : `${n} paths`;
  }

  kindLabel(): string {
    const entries = this.resolvedEntries();
    if (entries.length !== 1) {
      return 'Paths';
    }
    return entries[0].kind === 'directory' ? 'Directory' : 'File';
  }

  recursiveWarning(): string {
    const entries = this.resolvedEntries();
    const anyRecDir = entries.some((e) => e.recursive && e.kind === 'directory');
    return anyRecDir ? 'Includes recursive directory deletes.' : '';
  }

  async onConfirm(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.targetSessionId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    const res = await this.electron.notifyAgentContinue(id, '', 'confirm', req);
    this.busy.set(false);
    if (!res.ok) {
      this.continueSent = false;
      this.deleteReviewFinished.emit({
        requestId: req,
        status: 'complete',
        summary: res.error ?? 'Request failed',
      });
      return;
    }
    this.deleteReviewFinished.emit({ requestId: req, status: 'complete', summary: 'Confirmation sent; assistant resuming.' });
  }

  async onCancel(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.targetSessionId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    await this.electron.notifyAgentContinue(id, '', 'cancel', req);
    this.busy.set(false);
    this.deleteReviewFinished.emit({ requestId: req, status: 'cancelled', summary: 'Cancelled.' });
  }
}
