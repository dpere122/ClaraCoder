import { CommonModule } from '@angular/common';
import { Component, effect, inject, Injector, input, OnDestroy, output, signal, untracked } from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { CopyConfirmPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HITL_BTN_SPINNER_TYPE, newHitlBtnSpinnerName, scheduleHitlBtnSpinner } from '../../chat/hitl-btn-spinner';

@Component({
  selector: 'app-copy-confirm',
  standalone: true,
  imports: [CommonModule, NgxSpinnerComponent],
  templateUrl: './copy-confirm.html',
  styleUrl: './copy-confirm.css',
})
export class CopyConfirmComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  readonly payload = input.required<CopyConfirmPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly copyReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  readonly busySpinnerName = newHitlBtnSpinnerName('copy');
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

  copyCountLabel(): string {
    const count = this.payload().copies.length;
    return `${count} file${count === 1 ? '' : 's'}`;
  }

  async onConfirm(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    const res = await this.electron.notifyAgentContinue(id, '', undefined, undefined, 'confirm', req);
    this.busy.set(false);
    if (!res.ok) {
      this.continueSent = false;
      this.copyReviewFinished.emit({
        requestId: req,
        status: 'complete',
        summary: res.error ?? 'Request failed',
      });
      return;
    }
    this.copyReviewFinished.emit({
      requestId: req,
      status: 'complete',
      summary: `Copied ${this.copyCountLabel()}; assistant resuming.`,
    });
  }

  async onCancel(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    await this.electron.notifyAgentContinue(id, '', undefined, undefined, 'cancel', req);
    this.busy.set(false);
    this.copyReviewFinished.emit({ requestId: req, status: 'cancelled', summary: 'Cancelled.' });
  }
}
