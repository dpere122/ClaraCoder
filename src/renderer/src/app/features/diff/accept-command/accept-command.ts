import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import {
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION,
  ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL,
  type AcceptCommandFinishedEvent,
  type AcceptCommandPayload,
  type DiffReviewStatus,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import {
  HITL_BTN_SPINNER_TYPE,
  newHitlBtnSpinnerName,
  scheduleHitlBtnSpinner,
} from '../../chat/hitl-btn-spinner';

export interface AcceptCommandContextHint {
  kind: string;
  value: string;
}

function indicativeDetailKind(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes('working directory')) {
    return 'cwd';
  }
  if (normalized.includes('elevation')) {
    return 'elevation';
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
  imports: [CommonModule, NgxSpinnerComponent],
  templateUrl: './accept-command.html',
  styleUrl: './accept-command.css',
})
export class AcceptCommandComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  readonly payload = input.required<AcceptCommandPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly acceptCommandFinished = output<AcceptCommandFinishedEvent>();

  readonly busy = signal(false);
  readonly busySpinnerName = newHitlBtnSpinnerName('accept');
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

  readonly confirmSessionLabel = computed(() => this.payload().confirmSessionLabel?.trim() || '');

  private isLocalAdminGrant(): boolean {
    return this.payload().kind === ACCEPT_COMMAND_KIND_ADMIN_ELEVATION;
  }

  private isAgentAdminGrant(): boolean {
    return this.payload().kind === ACCEPT_COMMAND_KIND_ADMIN_ELEVATION_TOOL;
  }

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
    await this.submitAcceptAction('confirm', this.payload().confirmLabel);
  }

  async onConfirmSession(): Promise<void> {
    const label = this.confirmSessionLabel() || 'Allow for this session';
    await this.submitAcceptAction('confirm_session', label);
  }

  async onCancel(): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const req = this.payload().requestId;
    const kind = this.payload().kind;
    if (kind === 'mcp_tool') {
      const id = this.conversationId();
      if (!id) return;
      this.busy.set(true);
      this.continueSent = true;
      await this.persistMcpDecision('deny');
      await this.electron.notifyAgentContinue(id, '', undefined, undefined, undefined, undefined, 'deny', req);
      this.busy.set(false);
      this.acceptCommandFinished.emit({
        requestId: req,
        status: 'cancelled',
        summary: 'Denied.',
        action: 'deny',
        kind,
      });
      return;
    }
    if (this.isLocalAdminGrant()) {
      this.continueSent = true;
      this.acceptCommandFinished.emit({
        requestId: req,
        status: 'cancelled',
        summary: 'Cancelled.',
        action: 'cancel',
        kind,
      });
      return;
    }
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
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
    this.acceptCommandFinished.emit({
      requestId: req,
      status: 'cancelled',
      summary: 'Cancelled.',
      action: 'cancel',
      kind,
    });
  }

  /** Store Allow, Deny, or Allow-all before the agent resumes, so a later Settings save cannot drop it. */
  private async persistMcpDecision(action: 'confirm' | 'confirm_session' | 'deny'): Promise<void> {
    const payload = this.payload();
    const serverId = payload.mcpServerId?.trim();
    if (!serverId) return;
    const decision = action === 'confirm_session' ? 'allow-all' : action === 'deny' ? 'deny' : 'allow';
    await this.electron.mcpRememberDecision({
      serverId,
      decision,
      toolName: payload.mcpToolName,
    });
  }

  private async submitAcceptAction(
    action: 'confirm' | 'confirm_session',
    summaryLabel: string,
  ): Promise<void> {
    if (this.continueSent || this.busy() || this.reviewStatus() !== 'pending') return;
    const req = this.payload().requestId;
    const kind = this.payload().kind;
    if (kind === 'mcp_tool') {
      await this.persistMcpDecision(action);
    }
    if (this.isLocalAdminGrant()) {
      const conversationId = this.conversationId();
      if (!conversationId) return;
      this.busy.set(true);
      this.continueSent = true;
      const res = await this.electron.syncAdminElevation(conversationId, true);
      this.busy.set(false);
      if (!res.ok) {
        this.continueSent = false;
        this.acceptCommandFinished.emit({
          requestId: req,
          status: 'cancelled',
          summary: res.error ?? 'Administrator prompt was cancelled or failed.',
          action,
          kind,
        });
        return;
      }
      this.acceptCommandFinished.emit({
        requestId: req,
        status: 'complete',
        summary: `${summaryLabel} granted for this agent.`,
        action,
        kind,
      });
      return;
    }
    const id = this.conversationId();
    if (!id) return;
    this.busy.set(true);
    this.continueSent = true;
    if (this.isAgentAdminGrant()) {
      const grant = await this.electron.syncAdminElevation(id, true);
      if (!grant.ok) {
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
        this.continueSent = false;
        this.acceptCommandFinished.emit({
          requestId: req,
          status: 'cancelled',
          summary: grant.error ?? 'Administrator prompt was cancelled or failed.',
          action: 'cancel',
          kind,
        });
        return;
      }
    }
    const res = await this.electron.notifyAgentContinue(
      id,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      action,
      req,
    );
    this.busy.set(false);
    if (!res.ok) {
      this.continueSent = false;
      this.acceptCommandFinished.emit({
        requestId: req,
        status: 'cancelled',
        summary: res.error ?? 'Request failed',
        action,
        kind,
      });
      return;
    }
    this.acceptCommandFinished.emit({
      requestId: req,
      status: 'complete',
      summary: `${summaryLabel} sent; assistant resuming.`,
      action,
      kind,
    });
  }
}
