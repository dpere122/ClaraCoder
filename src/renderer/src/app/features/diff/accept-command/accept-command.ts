import { CommonModule } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import type { AcceptCommandPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-accept-command',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './accept-command.html',
  styleUrl: './accept-command.css',
})
export class AcceptCommandComponent {
  private readonly electron = inject(ElectronService);

  readonly payload = input.required<AcceptCommandPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly acceptCommandFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  private continueSent = false;

  async onConfirm(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    const res = await this.electron.notifyAgentContinue(
      id,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      'confirm',
      req,
    );
    this.busy.set(false);
    if (!res.ok) {
      this.continueSent = false;
      this.acceptCommandFinished.emit({
        requestId: req,
        status: 'complete',
        summary: res.error ?? 'Request failed',
      });
      return;
    }
    this.acceptCommandFinished.emit({
      requestId: req,
      status: 'complete',
      summary: `${this.payload().confirmLabel} sent; assistant resuming.`,
    });
  }

  async onCancel(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = this.payload().requestId;
    await this.electron.notifyAgentContinue(
      id,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      'cancel',
      req,
    );
    this.busy.set(false);
    this.acceptCommandFinished.emit({ requestId: req, status: 'cancelled', summary: 'Cancelled.' });
  }
}
