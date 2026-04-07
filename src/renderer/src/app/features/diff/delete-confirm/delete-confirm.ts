import { CommonModule } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import type { DeleteConfirmPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-delete-confirm',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './delete-confirm.html',
  styleUrl: './delete-confirm.css',
})
export class DeleteConfirmComponent {
  private readonly electron = inject(ElectronService);

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
  private continueSent = false;

  kindLabel(): string {
    return this.payload().kind === 'directory' ? 'Directory' : 'File';
  }

  recursiveWarning(): string {
    return this.payload().recursive && this.payload().kind === 'directory'
      ? 'This will remove the directory and all of its contents.'
      : '';
  }

  async onConfirm(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
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
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    await this.electron.notifyAgentContinue(id, '', 'cancel', req);
    this.busy.set(false);
    this.deleteReviewFinished.emit({ requestId: req, status: 'cancelled', summary: 'Cancelled.' });
  }
}
