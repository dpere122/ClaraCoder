import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { AcceptCommandPayload, DiffReviewStatus } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

export interface AcceptCommandContextHint {
  kind: string;
  value: string;
}

function indicativeDetailKind(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes('working directory')) {
    return 'cwd';
  }
  if (normalized.includes('entry script')) {
    return 'script';
  }
  if (normalized.includes('project dir')) {
    return 'dir';
  }
  if (normalized.includes('script')) {
    return 'script';
  }
  return '';
}

function parseDetailItem(item: string): AcceptCommandContextHint {
  const trimmed = item.trim();
  const labeled = trimmed.match(/^([^:]+):\s*(.+)$/);
  if (!labeled) {
    return { kind: '', value: trimmed };
  }
  const value = labeled[2].replace(/^`|`$/g, '').trim();
  return {
    kind: indicativeDetailKind(labeled[1]),
    value: value || trimmed,
  };
}

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

  readonly summaryText = computed(() => {
    const p = this.payload();
    return p.message.trim() || p.title.trim() || p.commandText.trim() || 'Approval';
  });

  readonly descriptionText = computed(() => {
    const p = this.payload();
    const parts: string[] = [];
    const message = p.message.trim();
    if (message) {
      parts.push(message);
    }
    if (p.riskAssessmentStatus === 'ok') {
      const riskDescription = p.riskDescription?.trim();
      if (riskDescription && riskDescription !== message) {
        parts.push(riskDescription);
      }
    }
    return parts.join('\n\n');
  });

  readonly contextHints = computed(() =>
    this.payload()
      .details.map(parseDetailItem)
      .filter((hint) => hint.value.length > 0),
  );

  /** Maps the payload's risk assessment fields to a Bootstrap badge class + label, or null if none applies. */
  readonly riskBadge = computed<{ badgeClass: string; label: string } | null>(() => {
    const p = this.payload();
    if (p.riskAssessmentStatus === 'ok') {
      switch (p.riskLevel) {
        case 'low':
          return { badgeClass: 'text-bg-success', label: 'Low risk' };
        case 'medium':
          return { badgeClass: 'text-bg-warning', label: 'Medium risk' };
        case 'high':
          return { badgeClass: 'text-bg-danger', label: 'High risk' };
        default:
          return null;
      }
    }
    if (p.riskAssessmentStatus === 'failed') {
      return { badgeClass: 'text-bg-secondary', label: 'Risk unknown' };
    }
    return null;
  });

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
        status: 'cancelled',
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
