import {
  Component,
  ElementRef,
  Injector,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { DiffReviewStatus } from '@shared/index';
import {
  hitlTrailItemsFromArtifacts,
  hitlTrailPanelTitle,
  hitlTrailRowKindText,
  type HitlTrailArtifact,
} from '@shared/index';
import { AcceptCommandComponent } from '../../../diff/accept-command/accept-command';
import { CopyConfirmComponent } from '../../../diff/copy-confirm/copy-confirm';
import { DeleteConfirmComponent } from '../../../diff/delete-confirm/delete-confirm';
import { DiffApplyComponent } from '../../../diff/diff-apply/diff-apply';
import { StagedTransferBatchReviewComponent } from '../../../diff/staged-transfer-batch-review/staged-transfer-batch-review';
import {
  type AuxiliaryPanelMode,
  auxiliaryPanelContentVisible,
  auxiliaryPanelShouldAutoScrollPreview,
  initialAuxiliaryPanelMode,
  resolveAuxiliaryPanelModeForLive,
  toggleAuxiliaryPanelMode,
} from '../auxiliary-stream-panel/auxiliary-stream-panel-modes';

@Component({
  selector: 'app-hitl-trail-panel',
  standalone: true,
  imports: [DiffApplyComponent, DeleteConfirmComponent, CopyConfirmComponent, AcceptCommandComponent, StagedTransferBatchReviewComponent],
  templateUrl: './hitl-trail-panel.html',
  styleUrls: ['../stream-trail-panel-shared.css', './hitl-trail-panel.css'],
  encapsulation: ViewEncapsulation.None,
})
export class HitlTrailPanelComponent {
  private readonly inj = inject(Injector);

  readonly artifacts = input.required<HitlTrailArtifact[]>();
  readonly live = input(false);
  readonly conversationId = input<string | null>(null);

  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
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
  readonly acceptCommandFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly stagedTransferBatchFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }>();

  readonly mode = signal<AuxiliaryPanelMode>(initialAuxiliaryPanelMode(false));
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private prevLive: boolean | undefined;
  private prevPendingCount = 0;

  readonly trailItems = computed(() => hitlTrailItemsFromArtifacts(this.artifacts()));
  readonly pendingArtifacts = computed(() =>
    this.artifacts().filter((a) => this.reviewStatus(a) === 'pending'),
  );
  readonly panelTitle = computed(() => hitlTrailPanelTitle(this.trailItems(), this.live()));
  readonly contentVisible = computed(() => auxiliaryPanelContentVisible(this.mode()));
  readonly isExpanded = computed(() => this.mode() === 'expanded');
  readonly showExpandedDetails = computed(() => this.mode() === 'expanded' && this.pendingArtifacts().length > 0);

  readonly rowKindText = hitlTrailRowKindText;

  trackItemId = (item: { id: string }) => item.id;

  artifactTrackKey(artifact: HitlTrailArtifact): string {
    switch (artifact.role) {
      case 'diff': {
        const p = artifact.payload;
        return `diff:${p.relativePath}|${p.baseSha256 ?? ''}|${p.rows.length}|${p.fullNewContent.length}`;
      }
      case 'accept_command':
        return `accept:${artifact.payload.requestId}`;
      case 'copy_confirm':
        return `copy:${artifact.payload.requestId}`;
      case 'delete_confirm':
        return `del:${artifact.payload.requestId}`;
      case 'plan_confirm':
        return `plan:${artifact.payload.requestId}`;
      case 'staged_transfer_batch':
        return `staged:${artifact.payload.requestId}|${artifact.payload.files.length}`;
      default:
        return 'artifact';
    }
  }

  reviewStatus(artifact: HitlTrailArtifact): DiffReviewStatus {
    return artifact.reviewStatus ?? 'pending';
  }

  constructor() {
    effect(() => {
      const isLive = this.live();
      const prevLive = this.prevLive;
      this.prevLive = isLive;
      const next = resolveAuxiliaryPanelModeForLive(this.mode(), isLive, prevLive);
      if (next !== this.mode()) {
        this.mode.set(next);
      }
    });

    effect(() => {
      const pendingCount = this.pendingArtifacts().length;
      const isLive = this.live();
      const prevCount = this.prevPendingCount;
      this.prevPendingCount = pendingCount;
      const stagedTransferPending = this.pendingArtifacts().some(
        (a) =>
          a.role === 'staged_transfer_batch' ||
          (a.role === 'diff' && a.payload.stagedTransferHitl),
      );
      if (isLive && pendingCount > 0 && (pendingCount > prevCount || stagedTransferPending)) {
        this.mode.set('expanded');
      }
    });

    effect(() => {
      this.trailItems();
      const mode = this.mode();
      if (!auxiliaryPanelShouldAutoScrollPreview(mode)) {
        return;
      }
      untracked(() => {
        afterNextRender(
          () => {
            const el = this.viewport()?.nativeElement;
            if (!el) return;
            el.scrollTop = el.scrollHeight;
          },
          { injector: this.inj },
        );
      });
    });
  }

  toggleMode(): void {
    this.mode.update((m) => toggleAuxiliaryPanelMode(m, this.live()));
  }
}
