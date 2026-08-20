import { CommonModule } from '@angular/common';
import {
  afterNextRender,
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
  ViewEncapsulation,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type {
  DiffReviewStatus,
  PlanConfirmFileChange,
  PlanConfirmPayload,
  AgentQuestionPayload,
  PlannerProgress,
  PlannerStep,
} from '@shared/index';
import { normalizePlanConfirmFilesToChange } from '@shared/index';
import { planPanelCompleteCount } from '../chat-box-display';
import { ElectronService } from '../../../../core/electron.service';
import { AgentQuestionComponent } from '../../../diff/agent-question/agent-question';
import { frameDisplayLabel, phaseDisplayLabel } from './planner-checklist-labels';

const PLAN_PROGRESS_SPINNER_TYPE = 'line-spin-fade' as const;

const INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--t-secondary)',
  type: PLAN_PROGRESS_SPINNER_TYPE,
};

@Component({
  selector: 'app-planner-checklist',
  standalone: true,
  imports: [CommonModule, NgxSpinnerComponent, AgentQuestionComponent],
  templateUrl: './planner-checklist.html',
  styleUrl: './planner-checklist.css',
  encapsulation: ViewEncapsulation.None,
})
export class PlannerChecklistComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  private readonly instanceId = `plan-${Math.random().toString(36).slice(2, 10)}`;
  private destroyed = false;

  readonly planProgressSpinnerType = PLAN_PROGRESS_SPINNER_TYPE;
  readonly headerSpinnerName = `${this.instanceId}-header`;
  readonly stepSpinnerName = `${this.instanceId}-step`;
  readonly approveSpinnerName = `${this.instanceId}-approve`;

  readonly planner = input.required<PlannerProgress>();
  readonly live = input(false);
  readonly conversationId = input<string | null>(null);
  readonly planConfirm = input<PlanConfirmPayload | null>(null);
  readonly planConfirmReviewStatus = input<DiffReviewStatus>('pending');
  readonly planConfirmReviewSummary = input<string | undefined>(undefined);
  readonly agentQuestion = input<AgentQuestionPayload | null>(null);
  readonly agentQuestionReviewStatus = input<DiffReviewStatus>('pending');
  readonly agentQuestionReviewSummary = input<string | undefined>(undefined);
  /**
   * When true, pending plan-confirm / agent-question actions render in the composer dock
   * instead of inside this progress panel.
   */
  readonly hitlActionsInComposerDock = input(false);

  readonly planConfirmFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly agentQuestionFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  private continueSent = false;

  readonly phaseLabel = computed(() =>
    phaseDisplayLabel(this.planner().phase, this.planner().planReady === true),
  );
  readonly completeCount = computed(() => planPanelCompleteCount(this.planner()));
  readonly totalSteps = computed(() => this.planner().steps.length);
  /** Structured file ops; tolerates legacy string entries on persisted plan_confirm artifacts. */
  readonly planFileChanges = computed((): PlanConfirmFileChange[] =>
    normalizePlanConfirmFilesToChange(this.planConfirm()?.filesToChange),
  );
  readonly progressPct = computed(() => {
    const total = this.totalSteps();
    if (total <= 0) return 0;
    return Math.round((this.completeCount() / total) * 100);
  });

  readonly showHeaderSpinner = computed(() => {
    if (!this.live()) return false;
    const phase = this.planner().phase;
    if (phase === 'discovery') return true;
    if (phase === 'planning' && this.planner().planReady !== true) return true;
    return phase === 'executing' && this.completeCount() < this.totalSteps();
  });

  readonly runningStepId = computed(() => {
    if (this.planner().phase === 'executing') {
      return null;
    }
    const activeId = this.planner().activeStepId;
    if (activeId) {
      const active = this.planner().steps.find((s) => s.id === activeId);
      if (active?.state === 'running') return activeId;
    }
    return this.planner().steps.find((s) => s.state === 'running')?.id ?? null;
  });

  readonly showApprovalActions = computed(
    () =>
      !this.hitlActionsInComposerDock() &&
      this.planConfirm() != null &&
      this.planConfirmReviewStatus() === 'pending' &&
      (this.planner().phase === 'planning' || this.planner().planReady === true),
  );

  readonly showAgentQuestion = computed(
    () =>
      !this.hitlActionsInComposerDock() &&
      this.agentQuestion() != null &&
      this.agentQuestionReviewStatus() === 'pending',
  );

  readonly frameLabel = computed(() =>
    frameDisplayLabel(this.planner().phase, this.showApprovalActions(), this.planner().planReady === true),
  );

  /** Continuous rail progress: completed steps + half-credit for the active step. */
  readonly railPct = computed(() => {
    const steps = this.planner().steps;
    const total = steps.length;
    if (total <= 0) return 0;
    let filled = 0;
    for (const step of steps) {
      if (step.state === 'complete') {
        filled += 1;
      } else if (
        step.state === 'running' ||
        (this.planner().activeStepId === step.id &&
          (this.planner().phase === 'executing' || this.planner().phase === 'discovery'))
      ) {
        filled += 0.55;
      }
    }
    return Math.min(100, Math.round((filled / total) * 100));
  });

  readonly approvalResolved = computed(
    () => this.planConfirm() != null && this.planConfirmReviewStatus() !== 'pending',
  );

  readonly approvalMessage = computed(() => {
    const confirm = this.planConfirm();
    if (!confirm?.message) {
      return '';
    }
    const base = confirm.message.trim();
    const path = confirm.buildPlanPath?.trim();
    if (path) {
      return `${base} Review the build plan in the preview tab (${path}).`;
    }
    return base;
  });

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
      untracked(() => this.scheduleHeaderSpinnerSync(showHeader));
    });

    effect(() => {
      const runningId = this.runningStepId();
      untracked(() => this.scheduleStepSpinnerSync(runningId != null));
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
    this.destroyed = true;
    void this.ngxSpinner.hide(this.headerSpinnerName);
    void this.ngxSpinner.hide(this.stepSpinnerName);
    void this.ngxSpinner.hide(this.approveSpinnerName);
  }

  /** Defer until ngx-spinner hosts mount (step marker is created inside @for). */
  private scheduleStepSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (this.destroyed) return;
        if (show) {
          void this.ngxSpinner.show(this.stepSpinnerName, INLINE_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.stepSpinnerName);
        }
      },
      { injector: this.inj },
    );
  }

  private scheduleHeaderSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (this.destroyed) return;
        if (show) {
          void this.ngxSpinner.show(this.headerSpinnerName, INLINE_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.headerSpinnerName);
        }
      },
      { injector: this.inj },
    );
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
      undefined,
      undefined,
      'cancel',
      req,
    );
    this.busy.set(false);
    this.planConfirmFinished.emit({ requestId: req, status: 'cancelled', summary: 'Plan cancelled.' });
  }
}
