import { Component, computed, input, output, ViewEncapsulation } from '@angular/core';
import type { DiffReviewStatus, HitlTrailArtifact, ThemeProposalFinishedEvent } from '@shared/index';
import { AcceptCommandComponent } from '../../diff/accept-command/accept-command';
import { AgentQuestionComponent } from '../../diff/agent-question/agent-question';
import { CopyConfirmComponent } from '../../diff/copy-confirm/copy-confirm';
import { DeleteConfirmComponent } from '../../diff/delete-confirm/delete-confirm';
import { PlanConfirmComponent } from '../../diff/plan-confirm/plan-confirm';
import { ThemeProposalComponent } from '../../diff/theme-proposal/theme-proposal';
import type { AcceptCommandFinishedEvent } from '@shared/index';

/** Legacy edit-review roles: agent edits now land on disk and are reviewed at end of turn. */
const READ_ONLY_HITL_ROLES = new Set<HitlTrailArtifact['role']>(['diff', 'staged_transfer_batch']);

/**
 * Slide-up dock above the INPUT composer for pending HITL review cards.
 * Compact change rows stay in the auxiliary stream; interactive reviews live here.
 * Old persisted edit cards (`diff`, `staged_transfer_batch`) render read-only in the trail only.
 */
@Component({
  selector: 'app-hitl-composer-dock',
  standalone: true,
  imports: [
    DeleteConfirmComponent,
    CopyConfirmComponent,
    AcceptCommandComponent,
    PlanConfirmComponent,
    AgentQuestionComponent,
    ThemeProposalComponent,
  ],
  templateUrl: './hitl-composer-dock.html',
  styleUrl: './hitl-composer-dock.css',
  encapsulation: ViewEncapsulation.None,
})
export class HitlComposerDockComponent {
  readonly artifacts = input.required<HitlTrailArtifact[]>();
  readonly conversationId = input<string | null>(null);

  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly copyReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly acceptCommandFinished = output<AcceptCommandFinishedEvent>();
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
  readonly themeProposalFinished = output<ThemeProposalFinishedEvent>();

  readonly pendingArtifacts = computed(() =>
    this.artifacts().filter((a) => !READ_ONLY_HITL_ROLES.has(a.role) && this.reviewStatus(a) === 'pending'),
  );

  readonly open = computed(() => this.pendingArtifacts().length > 0);

  artifactTrackKey(artifact: HitlTrailArtifact): string {
    switch (artifact.role) {
      case 'accept_command':
        return `accept:${artifact.payload.requestId}`;
      case 'copy_confirm':
        return `copy:${artifact.payload.requestId}`;
      case 'delete_confirm':
        return `del:${artifact.payload.requestId}`;
      case 'plan_confirm':
        return `plan:${artifact.payload.requestId}`;
      case 'agent_question':
        return `question:${artifact.payload.requestId}`;
      case 'theme_proposal':
        return `theme:${artifact.payload.requestId}`;
      default:
        return 'artifact';
    }
  }

  reviewStatus(artifact: HitlTrailArtifact): DiffReviewStatus {
    return artifact.reviewStatus ?? 'pending';
  }
}
