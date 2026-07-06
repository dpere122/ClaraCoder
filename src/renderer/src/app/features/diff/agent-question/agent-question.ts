import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { DiffReviewStatus, AgentQuestionPayload, QuestionAnswer } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

interface QuestionSelection {
  optionId?: string;
  otherText?: string;
  otherActive: boolean;
}

@Component({
  selector: 'app-agent-question',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './agent-question.html',
  styleUrl: './agent-question.css',
})
export class AgentQuestionComponent {
  private readonly electron = inject(ElectronService);

  readonly payload = input.required<AgentQuestionPayload>();
  readonly conversationId = input<string | null>(null);
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly agentQuestionFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly busy = signal(false);
  /** Per-question id -> selection. */
  readonly selections = signal<Record<string, QuestionSelection>>({});

  readonly canSubmit = computed(() => {
    const questions = this.payload().questions ?? [];
    if (questions.length === 0) return false;
    return questions.every((q) => {
      const sel = this.selections()[q.id];
      if (!sel) return false;
      return Boolean(sel.optionId || (sel.otherActive && sel.otherText?.trim()));
    });
  });

  selectOption(questionId: string, optionId: string): void {
    this.selections.update((prev) => ({
      ...prev,
      [questionId]: { optionId, otherText: undefined, otherActive: false },
    }));
  }

  selectOther(questionId: string): void {
    this.selections.update((prev) => ({
      ...prev,
      [questionId]: { optionId: undefined, otherText: prev[questionId]?.otherText ?? '', otherActive: true },
    }));
  }

  setOtherText(questionId: string, text: string): void {
    this.selections.update((prev) => {
      const cur = prev[questionId] ?? { otherActive: true };
      return { ...prev, [questionId]: { optionId: undefined, otherText: text, otherActive: true } };
    });
  }

  isOptionSelected(questionId: string, optionId: string): boolean {
    return this.selections()[questionId]?.optionId === optionId;
  }

  isOtherSelected(questionId: string): boolean {
    return this.selections()[questionId]?.otherActive === true;
  }

  private collectAnswers(): QuestionAnswer[] {
    const out: QuestionAnswer[] = [];
    for (const q of this.payload().questions ?? []) {
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
    this.busy.set(true);
    const req = this.payload().requestId;
    await this.electron.notifyAgentQuestionAnswers(id, 'cancel', req, []);
    this.busy.set(false);
    this.agentQuestionFinished.emit({ requestId: req, status: 'cancelled', summary: 'Questions cancelled.' });
  }
}
