import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { DiffReviewStatus, PlanConfirmPayload, PlannerProgress, PlannerStep } from '@shared/index';
import { planPanelCompleteCount } from '../chat-box-display';
import { ElectronService } from '../../../../core/electron.service';

const INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--t-secondary)',
};

@Component({
  selector: 'app-planner-checklist',
  standalone: true,
  imports: [CommonModule, NgxSpinnerComponent],
  templateUrl: './planner-checklist.html',
  styleUrl: './planner-checklist.css',
  encapsulation: ViewEncapsulation.None,
})
export class PlannerChecklistComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly instanceId = `plan-${Math.random().toString(36).slice(2, 10)}`;

  readonly headerSpinnerName = `${this.instanceId}-header`;
  readonly stepSpinnerName = `${this.instanceId}-step`;
  readonly approveSpinnerName = `${this.instanceId}-approve`;

  readonly planner = input.required<PlannerProgress>();
  readonly live = input(false);
  readonly conversationId = input<string | null>(null);
  readonly planConfirm = input<PlanConfirmPayload | null>(null);
  readonly planConfirmReviewStatus = input<DiffReviewStatus>('pending');
  readonly planConfirmReviewSummary = input<string | undefined>(undefined);

  readonly planConfirmFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  private continueSent = false;

  readonly phaseLabel = computed(() => phaseDisplayLabel(this.planner().phase));
  readonly completeCount = computed(() => planPanelCompleteCount(this.planner()));
  readonly totalSteps = computed(() => this.planner().steps.length);
  readonly progressPct = computed(() => {
    const total = this.totalSteps();
    if (total <= 0) return 0;
    return Math.round((this.completeCount() / total) * 100);
  });

  readonly showHeaderSpinner = computed(() => {
    if (!this.live()) return false;
    const phase = this.planner().phase;
    if (phase === 'discovery') return true;
    return phase === 'executing' && this.completeCount() < this.totalSteps();
  });

  readonly runningStepId = computed(() => {
    const activeId = this.planner().activeStepId;
    if (activeId) {
      const active = this.planner().steps.find((s) => s.id === activeId);
      if (active?.state === 'running') return activeId;
    }
    return this.planner().steps.find((s) => s.state === 'running')?.id ?? null;
  });

  readonly showApprovalActions = computed(
    () =>
      this.planConfirm() != null &&
      this.planConfirmReviewStatus() === 'pending' &&
      (this.planner().phase === 'planning' || this.planner().planReady === true),
  );

  readonly approvalResolved = computed(
    () => this.planConfirm() != null && this.planConfirmReviewStatus() !== 'pending',
  );

  isActiveStep(step: PlannerStep): boolean {
    const activeId = this.planner().activeStepId;
    return activeId != null && activeId === step.id;
  }

  isRunningStep(step: PlannerStep): boolean {
    const phase = this.planner().phase;
    return (
      step.state === 'running' ||
      (this.isActiveStep(step) && (phase === 'executing' || phase === 'discovery'))
    );
  }

  constructor() {
    effect(() => {
      const showHeader = this.showHeaderSpinner();
      if (showHeader) {
        void this.ngxSpinner.show(this.headerSpinnerName, { ...INLINE_SPINNER, type: 'line-spin-fade' });
      } else {
        void this.ngxSpinner.hide(this.headerSpinnerName);
      }
    });

    effect(() => {
      const runningId = this.runningStepId();
      if (runningId) {
        void this.ngxSpinner.show(this.stepSpinnerName, { ...INLINE_SPINNER, type: 'ball-clip-rotate' });
      } else {
        void this.ngxSpinner.hide(this.stepSpinnerName);
      }
    });

    effect(() => {
      if (this.busy()) {
        void this.ngxSpinner.show(this.approveSpinnerName, { ...INLINE_SPINNER, type: 'ball-scale-multiple' });
      } else {
        void this.ngxSpinner.hide(this.approveSpinnerName);
      }
    });
  }

  ngOnDestroy(): void {
    void this.ngxSpinner.hide(this.headerSpinnerName);
    void this.ngxSpinner.hide(this.stepSpinnerName);
    void this.ngxSpinner.hide(this.approveSpinnerName);
  }

  async onConfirm(): Promise<void> {
    if (this.continueSent || this.busy() || !this.showApprovalActions()) return;
    const id = this.conversationId();
    const confirm = this.planConfirm();
    if (!id || !confirm) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = confirm.requestId;
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
      summary: `${confirm.confirmLabel} sent; executing plan.`,
    });
  }

  async onCancel(): Promise<void> {
    if (this.continueSent || this.busy() || !this.showApprovalActions()) return;
    const id = this.conversationId();
    const confirm = this.planConfirm();
    if (!id || !confirm) return;
    this.busy.set(true);
    this.continueSent = true;
    const req = confirm.requestId;
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
      'cancel',
      req,
    );
    this.busy.set(false);
    this.planConfirmFinished.emit({ requestId: req, status: 'cancelled', summary: 'Plan cancelled.' });
  }
}

function phaseDisplayLabel(phase: PlannerProgress['phase']): string {
  switch (phase) {
    case 'planning':
      return 'Ready for review';
    case 'executing':
      return 'Running';
    case 'complete':
      return 'Complete';
    case 'error':
      return 'Failed';
    case 'discovery':
      return 'Discovering';
    default:
      return phase;
  }
}
