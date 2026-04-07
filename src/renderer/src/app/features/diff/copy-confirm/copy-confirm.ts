import { CommonModule } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import type { CopyConfirmPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-copy-confirm',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './copy-confirm.html',
  styleUrl: './copy-confirm.css',
})
export class CopyConfirmComponent {
  private readonly electron = inject(ElectronService);

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
  private continueSent = false;

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
