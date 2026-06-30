import { CommonModule } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import type { DiffReviewStatus, PlanConfirmPayload } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

@Component({
  selector: 'app-plan-confirm',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './plan-confirm.html',
  styleUrl: './plan-confirm.css',
})
export class PlanConfirmComponent {
  private readonly electron = inject(ElectronService);

  readonly payload = input.required<PlanConfirmPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly planConfirmFinished = output<{
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
      undefined,
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
      this.planConfirmFinished.emit({
        requestId: req,
        status: 'complete',
        summary: res.error ?? 'Request failed',
      });
      return;
    }
    this.planConfirmFinished.emit({
      requestId: req,
      status: 'complete',
      summary: `${this.payload().confirmLabel} sent; executing plan.`,
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'cancel',
      req,
    );
    this.busy.set(false);
    this.planConfirmFinished.emit({ requestId: req, status: 'cancelled', summary: 'Plan cancelled.' });
  }
}
