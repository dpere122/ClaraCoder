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
import type { DiffReviewStatus, AgentQuestionPayload, QuestionAnswer } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { HITL_BTN_SPINNER_TYPE, newHitlBtnSpinnerName, scheduleHitlBtnSpinner } from '../../chat/hitl-btn-spinner';

interface QuestionSelection {
  optionId?: string;
  otherText?: string;
  otherActive: boolean;
}

/** Pause after a choice so the selection reads before the next card slides in. */
const AUTO_ADVANCE_MS = 220;
/** Horizontal drag distance (px) that flips to the neighbouring card. */
const SWIPE_THRESHOLD_PX = 48;

/**
 * Plan-mode clarifying questions as a carousel: one card per question, cycled left and right
 * (arrows, dots, ←/→, swipe). Picking an option moves on to the next unanswered card; submit
 * unlocks once every question has an answer.
 */
@Component({
  selector: 'app-agent-question',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, NgxSpinnerComponent],
  templateUrl: './agent-question.html',
  styleUrl: './agent-question.css',
  encapsulation: ViewEncapsulation.None,
})
export class AgentQuestionComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  readonly payload = input.required<AgentQuestionPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);
  /** Inside the plan dock the dock header already names the phase; drop the card's own title row. */
  readonly embedded = input(false);

  readonly agentQuestionFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  private readonly slidesRef = viewChild<ElementRef<HTMLElement>>('slides');

  readonly busy = signal(false);
  readonly busySpinnerName = newHitlBtnSpinnerName('question');
  readonly busySpinnerType = HITL_BTN_SPINNER_TYPE;
  /** Per-question id -> selection. */
  readonly selections = signal<Record<string, QuestionSelection>>({});
  /** Card in view. */
  readonly index = signal(0);

  private advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private swipeStartX: number | null = null;
  private swipeStartY = 0;

  readonly questions = computed(() => this.payload().questions ?? []);
  readonly total = computed(() => this.questions().length);
  readonly current = computed(() => this.questions()[this.index()] ?? null);

  /** Choices on the card in view, "Other" included (number-key range). */
  readonly choiceCount = computed(() => {
    const q = this.current();
    return q ? q.options.length + (q.allowOther ? 1 : 0) : 0;
  });

  readonly answeredCount = computed(() => this.questions().filter((q) => this.isAnswered(q.id)).length);

  readonly canSubmit = computed(() => {
    const questions = this.questions();
    return questions.length > 0 && questions.every((q) => this.isAnswered(q.id));
  });

  constructor() {
    effect(() => {
      const loading = this.busy();
      untracked(() => scheduleHitlBtnSpinner(this.ngxSpinner, this.busySpinnerName, loading, this.inj));
    });
    // A new request starts on its first card.
    effect(() => {
      this.payload().requestId;
      untracked(() => {
        this.index.set(0);
        this.selections.set({});
      });
    });
  }

  ngOnDestroy(): void {
    this.clearAdvance();
    void this.ngxSpinner.hide(this.busySpinnerName);
  }

  isAnswered(questionId: string): boolean {
    const sel = this.selections()[questionId];
    return Boolean(sel && (sel.optionId || (sel.otherActive && sel.otherText?.trim())));
  }

  // --- Navigation ---

  goTo(i: number): void {
    const total = this.total();
    if (total === 0) return;
    this.clearAdvance();
    this.index.set(((i % total) + total) % total);
  }

  /** Arrows and ←/→ cycle: past the last card wraps to the first. */
  prev(): void {
    this.goTo(this.index() - 1);
  }

  next(): void {
    this.goTo(this.index() + 1);
  }

  /** Next card without an answer after the current one (wrapping), or -1 when all are answered. */
  private nextUnanswered(): number {
    const qs = this.questions();
    for (let step = 1; step <= qs.length; step++) {
      const i = (this.index() + step) % qs.length;
      if (!this.isAnswered(qs[i].id)) return i;
    }
    return -1;
  }

  private scheduleAdvance(): void {
    this.clearAdvance();
    const target = this.nextUnanswered();
    if (target < 0 || target === this.index()) return;
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      this.index.set(target);
    }, AUTO_ADVANCE_MS);
  }

  private clearAdvance(): void {
    if (this.advanceTimer != null) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  // --- Selection ---

  selectOption(questionId: string, optionId: string): void {
    this.selections.update((prev) => ({
      ...prev,
      [questionId]: { optionId, otherText: prev[questionId]?.otherText, otherActive: false },
    }));
    this.scheduleAdvance();
  }

  selectOther(questionId: string): void {
    this.clearAdvance();
    this.selections.update((prev) => ({
      ...prev,
      [questionId]: { optionId: undefined, otherText: prev[questionId]?.otherText ?? '', otherActive: true },
    }));
    afterNextRender(
      () => this.slidesRef()?.nativeElement.querySelector<HTMLInputElement>(`[data-other-for="${questionId}"]`)?.focus(),
      { injector: this.inj },
    );
  }

  setOtherText(questionId: string, text: string): void {
    this.selections.update((prev) => ({
      ...prev,
      [questionId]: { optionId: undefined, otherText: text, otherActive: true },
    }));
  }

  isOptionSelected(questionId: string, optionId: string): boolean {
    return this.selections()[questionId]?.optionId === optionId;
  }

  isOtherSelected(questionId: string): boolean {
    return this.selections()[questionId]?.otherActive === true;
  }

  // --- Keyboard / pointer ---

  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onPrimary();
      return;
    }
    if (typing) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.prev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.next();
    } else if (/^[1-9]$/.test(event.key)) {
      const q = this.current();
      if (!q) return;
      const n = Number(event.key) - 1;
      if (n < q.options.length) {
        event.preventDefault();
        this.selectOption(q.id, q.options[n].id);
      } else if (n === q.options.length && q.allowOther) {
        event.preventDefault();
        this.selectOther(q.id);
      }
    }
  }

  onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' || (event.target as HTMLElement)?.closest('input, button')) return;
    this.swipeStartX = event.clientX;
    this.swipeStartY = event.clientY;
  }

  onPointerUp(event: PointerEvent): void {
    if (this.swipeStartX == null) return;
    const dx = event.clientX - this.swipeStartX;
    const dy = event.clientY - this.swipeStartY;
    this.swipeStartX = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) this.next();
    else this.prev();
  }

  /** Footer primary: submit once complete, otherwise jump to the next open card. */
  onPrimary(): void {
    if (this.canSubmit()) {
      void this.onSubmit();
      return;
    }
    const target = this.nextUnanswered();
    if (target >= 0) this.goTo(target);
  }

  // --- Submit / cancel ---

  private collectAnswers(): QuestionAnswer[] {
    const out: QuestionAnswer[] = [];
    for (const q of this.questions()) {
      const sel = this.selections()[q.id];
      if (!sel) continue;
      const otherText = sel.otherActive ? sel.otherText?.trim() || undefined : undefined;
      out.push({
        questionId: q.id,
        optionId: sel.otherActive ? undefined : sel.optionId,
        otherText,
      });
    }
    return out;
  }

  async onSubmit(): Promise<void> {
    if (this.busy() || this.reviewStatus() !== 'pending' || !this.canSubmit()) return;
    const id = this.conversationId();
    if (!id) return;
    this.clearAdvance();
    this.busy.set(true);
    const req = this.payload().requestId;
    const res = await this.electron.notifyAgentQuestionAnswers(id, 'submit', req, this.collectAnswers());
    this.busy.set(false);
    if (!res.ok) {
      this.agentQuestionFinished.emit({
        requestId: req,
        status: 'complete',
        summary: res.error ?? 'Request failed',
      });
      return;
    }
    this.agentQuestionFinished.emit({
      requestId: req,
      status: 'complete',
      summary: 'Answers submitted; refining the plan.',
    });
  }

  async onCancel(): Promise<void> {
    if (this.busy() || this.reviewStatus() !== 'pending') return;
    const id = this.conversationId();
    if (!id) return;
    this.clearAdvance();
    this.busy.set(true);
    const req = this.payload().requestId;
    await this.electron.notifyAgentQuestionAnswers(id, 'cancel', req, []);
    this.busy.set(false);
    this.agentQuestionFinished.emit({ requestId: req, status: 'cancelled', summary: 'Questions cancelled.' });
  }
}
