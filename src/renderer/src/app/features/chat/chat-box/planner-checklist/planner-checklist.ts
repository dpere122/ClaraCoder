import { CommonModule } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
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
import { HITL_BTN_SPINNER_TYPE, newHitlBtnSpinnerName, scheduleHitlBtnSpinner } from '../../hitl-btn-spinner';
import { ToolSpinnerComponent } from '../tool-spinner/tool-spinner';
import type { SpinnerKind } from '../tool-spinner-kind';
import { planStages, planStatusText, planStopped, type PlanStatusInput } from './planner-checklist-labels';

/**
 * `dock`: the live plan, pinned to the top of the composer — stage strip, status, clarifying
 * questions, approval, and step progress. `transcript`: a finished turn's plan as one collapsible row.
 */
export type PlanPanelVariant = 'dock' | 'transcript';

@Component({
  selector: 'app-planner-checklist',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, NgxSpinnerComponent, AgentQuestionComponent, ToolSpinnerComponent],
  templateUrl: './planner-checklist.html',
  styleUrl: './planner-checklist.css',
  encapsulation: ViewEncapsulation.None,
})
export class PlannerChecklistComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  readonly planner = input.required<PlannerProgress>();
  readonly variant = input<PlanPanelVariant>('dock');
  readonly live = input(false);
  readonly conversationId = input<string | null>(null);
  readonly planConfirm = input<PlanConfirmPayload | null>(null);
  readonly planConfirmReviewStatus = input<DiffReviewStatus>('pending');
  readonly planConfirmReviewSummary = input<string | undefined>(undefined);
  readonly agentQuestion = input<AgentQuestionPayload | null>(null);
  readonly agentQuestionReviewStatus = input<DiffReviewStatus>('pending');
  readonly agentQuestionReviewSummary = input<string | undefined>(undefined);

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

  private readonly stepList = viewChild<ElementRef<HTMLElement>>('stepList');

  readonly busy = signal(false);
  readonly approveSpinnerName = newHitlBtnSpinnerName('plan');
  readonly approveSpinnerType = HITL_BTN_SPINNER_TYPE;
  /** Request id already answered, so a double click cannot send twice. */
  private sentRequestId: string | null = null;

  /** User toggle; `null` follows the variant default (dock open, transcript closed). */
  private readonly userCollapsed = signal<boolean | null>(null);

  readonly isDock = computed(() => this.variant() === 'dock');
  readonly completeCount = computed(() => planPanelCompleteCount(this.planner()));
  readonly totalSteps = computed(() => this.planner().steps.length);

  readonly questionPending = computed(
    () => this.isDock() && this.agentQuestion() != null && this.agentQuestionReviewStatus() === 'pending',
  );

  readonly approvalPending = computed(
    () =>
      this.isDock() &&
      this.planConfirm() != null &&
      this.planConfirmReviewStatus() === 'pending' &&
      (this.planner().phase === 'planning' || this.planner().planReady === true),
  );

  /** A decision is waiting on the user: the dock opens even if they collapsed it. */
  readonly needsInput = computed(() => this.questionPending() || this.approvalPending());

  readonly collapsed = computed(() => {
    if (this.needsInput()) return false;
    return this.userCollapsed() ?? !this.isDock();
  });

  private readonly statusInput = computed(
    (): PlanStatusInput => ({
      phase: this.planner().phase,
      planReady: this.planner().planReady === true,
      live: this.live(),
      questionPending: this.questionPending(),
      approvalPending: this.approvalPending(),
      questionCount: this.agentQuestion()?.questions?.length ?? 0,
      completeCount: this.completeCount(),
      totalSteps: this.totalSteps(),
    }),
  );

  readonly stages = computed(() => planStages(this.statusInput()));
  readonly statusText = computed(() => planStatusText(this.statusInput()));
  readonly stopped = computed(() => planStopped(this.statusInput()));

  /** Accent family for the panel: working, waiting on the user, done, failed, or stopped. */
  readonly tone = computed(() => {
    if (this.needsInput()) return 'input';
    if (this.stopped()) return 'stopped';
    const phase = this.planner().phase;
    if (phase === 'complete') return 'complete';
    if (phase === 'error') return 'error';
    return 'working';
  });

  readonly title = computed(() => {
    const title = this.planConfirm()?.title?.trim();
    // The backend's generic confirm title says nothing the "Plan" label does not.
    return title && title !== 'Review plan' ? title : '';
  });

  readonly showWorkingSpinner = computed(() => this.live() && this.tone() === 'working');

  readonly spinnerKind = computed((): SpinnerKind => (this.planner().phase === 'discovery' ? 'read' : 'write'));

  /** Step being worked on during execution (explicit active id, a running step, else the first open one). */
  readonly currentStepId = computed((): string | null => {
    const planner = this.planner();
    if (planner.phase !== 'executing') return null;
    const steps = planner.steps;
    const active = planner.activeStepId ? steps.find((s) => s.id === planner.activeStepId) : undefined;
    if (active && active.state !== 'complete') return active.id;
    return (
      steps.find((s) => s.state === 'running')?.id ??
      steps.find((s) => s.state !== 'complete' && s.state !== 'error')?.id ??
      null
    );
  });

  readonly currentStep = computed(() => {
    const id = this.currentStepId();
    return id ? (this.planner().steps.find((s) => s.id === id) ?? null) : null;
  });

  /** Progress bar: completed steps plus part credit for the step underway. */
  readonly progressPct = computed(() => {
    const total = this.totalSteps();
    if (total <= 0) return 0;
    if (this.planner().phase === 'complete') return 100;
    const partial = this.currentStepId() ? 0.5 : 0;
    return Math.min(100, Math.round(((this.completeCount() + partial) / total) * 100));
  });

  /** Steps stay out of the way while the user answers questions (the draft is in the preview tab). */
  readonly showSteps = computed(() => this.totalSteps() > 0 && !this.questionPending());

  /** Structured file ops; tolerates legacy string entries on persisted plan_confirm artifacts. */
  readonly planFileChanges = computed((): PlanConfirmFileChange[] =>
    normalizePlanConfirmFilesToChange(this.planConfirm()?.filesToChange),
  );

  readonly showDetails = computed(() => {
    const confirm = this.planConfirm();
    if (!confirm) return false;
    if (this.isDock() && !this.approvalPending()) return false;
    return (
      this.planFileChanges().length > 0 ||
      confirm.risks.length > 0 ||
      confirm.definitionOfDone.length > 0 ||
      confirm.resolvedQuestions.length > 0
    );
  });

  readonly approvalResolved = computed(
    () => this.planConfirm() != null && this.planConfirmReviewStatus() !== 'pending',
  );

  readonly buildPlanPath = computed(() => this.planConfirm()?.buildPlanPath?.trim() ?? '');

  constructor() {
    effect(() => {
      const loading = this.busy();
      untracked(() => scheduleHitlBtnSpinner(this.ngxSpinner, this.approveSpinnerName, loading, this.inj));
    });

    // Keep the step underway in view inside the dock's bounded list.
    effect(() => {
      const id = this.currentStepId();
      if (!id || !this.isDock()) return;
      untracked(() =>
        afterNextRender(
          () => {
            const list = this.stepList()?.nativeElement;
            const row = list?.querySelector<HTMLElement>(`[data-step-id="${id}"]`);
            if (!list || !row) return;
            const top = row.offsetTop - list.offsetTop;
            if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
              list.scrollTop = Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2);
            }
          },
          { injector: this.inj },
        ),
      );
    });
  }

  ngOnDestroy(): void {
    void this.ngxSpinner.hide(this.approveSpinnerName);
  }

  toggle(): void {
    if (this.needsInput()) return;
    this.userCollapsed.set(!this.collapsed());
  }

  stepMark(step: PlannerStep, index: number): 'spinner' | 'complete' | 'error' | 'current' | string {
    if (step.state === 'complete') return 'complete';
    if (step.state === 'error') return 'error';
    if (step.id === this.currentStepId()) return this.live() ? 'spinner' : 'current';
    return String(index + 1);
  }

  async onConfirm(): Promise<void> {
    const id = this.conversationId();
    const confirm = this.planConfirm();
    if (!id || !confirm || this.busy() || !this.approvalPending() || this.sentRequestId === confirm.requestId) return;
    this.busy.set(true);
    this.sentRequestId = confirm.requestId;
    const req = confirm.requestId;
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
      this.sentRequestId = null;
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
    const id = this.conversationId();
    const confirm = this.planConfirm();
    if (!id || !confirm || this.busy() || !this.approvalPending() || this.sentRequestId === confirm.requestId) return;
    this.busy.set(true);
    this.sentRequestId = confirm.requestId;
    const req = confirm.requestId;
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
    this.planConfirmFinished.emit({ requestId: req, status: 'cancelled', summary: 'Plan cancelled.' });
  }
}
