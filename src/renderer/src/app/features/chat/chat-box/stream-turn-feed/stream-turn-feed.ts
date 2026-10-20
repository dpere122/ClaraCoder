import {
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { StreamPart, TurnFeedItem } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import { MarkdownPipe } from '../markdown.pipe';
import { StreamNudgePillComponent } from '../stream-nudge-pill/stream-nudge-pill';
import { StreamThoughtPillComponent } from '../stream-thought-pill/stream-thought-pill';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import { ToolPillExpansion } from '../tool-pill-expansion';
import { ToolPillGroupComponent } from '../tool-pill-group/tool-pill-group';
import type { ToolSpinnerKind } from '../tool-spinner-kind';
import {
  committedItemIdentities,
  decidePreviewCommit,
  displayCommittedCount,
  feedDisplayRoles,
  initialLiveCommittedCount,
  firstQueueableIdentity,
  previewCommitCount,
  previewItemText,
  previewQueueHeader,
  previewQueueToolSpinnerKind,
  previewQueueMeta,
  previewShowsBody as previewItemShowsBody,
  previewSpinnerHost,
  pressureInbound,
  queueableFeedIdentity,
  queueableItems,
  splitQueuedFeed,
} from './stream-preview-queue';
import { settlingChipIndices, toolChipGroupParts, toolChipLayout } from './tool-chip-groups';

/** How long chips that just left the live preview play their settle animation (see the CSS). */
export const CHIP_SETTLE_MS = 520;

/** Spinner the open preview hosts: thought header, or the tool pill (read / write / run / web). */
export type HostedSpinnerKind = 'think' | ToolSpinnerKind;

@Component({
  selector: 'app-stream-turn-feed',
  standalone: true,
  imports: [
    AuxStreamToolPartComponent,
    MarkdownPipe,
    StreamNudgePillComponent,
    StreamThoughtPillComponent,
    StreamToolPillComponent,
    ToolPillGroupComponent,
  ],
  // Open pills are tracked per feed, so a pill keeps its state when it joins a group.
  providers: [ToolPillExpansion],
  templateUrl: './stream-turn-feed.html',
  styleUrl: './stream-turn-feed.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamTurnFeedComponent {
  readonly items = input.required<TurnFeedItem[]>();
  readonly live = input(false);
  /** Persisted markdown layout-pass bump; live feed leaves this at 0. */
  readonly markdownLayoutPass = input(0);
  /** Blinking cursor on the last markdown block while the reply is still streaming. */
  readonly showCursor = input(false);
  /** Compact tool details when the plan checklist is visible. */
  readonly planPanelVisible = input(false);
  /** Live turn is streaming (not blocked on HITL): host the turn spinner in the open preview slot. */
  readonly spinnerActive = input(false);

  /**
   * Emits whenever {@link hostedSpinnerKind} changes so the chat box can hide its own processing
   * row and report the exact spinner on screen. Pushed from an effect (after inputs bind) — the
   * parent must not read child state directly, as its template runs before this view's `items`
   * input is set (NG0950).
   */
  readonly spinnerKindChange = output<HostedSpinnerKind | null>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly previewBody = viewChild<ElementRef<HTMLElement>>('previewBody');

  /** How many queueable items have finished their live preview and landed as chips. */
  private readonly committedCount = signal(0);

  private firstIdentity: string | null = null;
  private currentIdentity = '';
  private currentTextLen = 0;
  private previewStartedAt = 0;
  private lastGrowthAt = 0;
  private inboundAppearedAt = 0;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  /** Queue identities of items that just committed from the live preview to chips. */
  private readonly settling = signal<ReadonlySet<string>>(new Set());
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  readonly displayCommitted = computed(() => displayCommittedCount(this.items(), this.committedCount()));

  /** How each item renders right now (chip, preview, hidden, markdown), by item index. */
  readonly displayRoles = computed(() => feedDisplayRoles(this.items(), this.displayCommitted(), this.live()));

  /** Back-to-back same-kind tool chips collapse into one group pill; duplicate rows fold away. */
  readonly toolChipLayout = computed(() => {
    const items = this.items();
    const roles = this.displayRoles();
    const layout = toolChipLayout(items, (index) => roles[index] ?? 'hidden', this.live());
    const groupParts = new Map<number, StreamPart[]>();
    for (const [lead, members] of layout.groups) {
      groupParts.set(lead, toolChipGroupParts(items, members));
    }
    return { hidden: layout.hidden, groupParts, groups: layout.groups };
  });

  /** Chips (and group pills) that just took over from the live preview: they fade and settle in. */
  readonly settlingIndices = computed(() =>
    settlingChipIndices(this.items(), this.settling(), this.toolChipLayout().groups),
  );

  readonly previewHeader = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return split.current ? previewQueueHeader(split.current, split.inbound) : '';
  });

  /** Path / drafting size / write-job phase beside the live tool pill (empty when not a tool preview). */
  readonly previewMeta = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewQueueMeta(split.current, split.inbound);
  });

  /** Tool spinner kind while the live preview is a tool pill. */
  readonly previewToolSpinnerKind = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewQueueToolSpinnerKind(split.current, split.inbound);
  });

  readonly previewShowsBody = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewItemShowsBody(split.current);
  });

  /**
   * Where the turn spinner lives right now: thought header, running tool pill, or `null`
   * (parent keeps it in the processing row).
   */
  readonly spinnerHost = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewSpinnerHost(this.live(), this.spinnerActive(), split.current);
  });

  /** Which spinner the preview hosts (`null` = none; the parent's processing row shows it). */
  readonly hostedSpinnerKind = computed<HostedSpinnerKind | null>(() => {
    const host = this.spinnerHost();
    if (host === 'header') {
      return 'think';
    }
    if (host === 'pill') {
      return this.previewToolSpinnerKind();
    }
    return null;
  });

  /** Header label letters for the shimmer animation while the spinner sits in the preview. */
  readonly previewHeaderChars = computed(() => Array.from(this.previewHeader()));

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearTimer();
      this.clearSettle();
    });

    effect(() => {
      const live = this.live();
      const items = this.items();
      untracked(() => this.syncQueue(live, items));
    });

    effect(() => {
      this.previewHeader();
      this.items();
      this.displayCommitted();
      untracked(() => {
        queueMicrotask(() => this.scrollPreviewToBottom());
      });
    });

    effect(() => {
      const kind = this.hostedSpinnerKind();
      untracked(() => this.spinnerKindChange.emit(kind));
    });
  }

  previewBodyText(item: TurnFeedItem): string {
    return previewItemText(item);
  }

  trackItem(item: TurnFeedItem, index: number): string {
    if (item.kind === 'markdown') {
      return `md:${index}`;
    }
    return `${item.kind}:${item.part.streamTag}:${index}`;
  }

  isLastMarkdown(index: number): boolean {
    const items = this.items();
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.kind === 'markdown') {
        return i === index;
      }
    }
    return false;
  }

  private syncQueue(live: boolean, items: TurnFeedItem[]): void {
    if (!live) {
      this.clearTimer();
      this.firstIdentity = firstQueueableIdentity(items);
      this.committedCount.set(queueableItems(items).length);
      this.currentIdentity = '';
      this.inboundAppearedAt = 0;
      return;
    }

    const first = firstQueueableIdentity(items);
    if (first !== this.firstIdentity) {
      this.firstIdentity = first;
      this.committedCount.set(initialLiveCommittedCount(items));
      this.currentIdentity = '';
      this.inboundAppearedAt = 0;
    }

    const advanced = displayCommittedCount(items, this.committedCount());
    if (advanced !== this.committedCount()) {
      this.committedCount.set(advanced);
    }

    const split = splitQueuedFeed(items, this.committedCount());
    const now = Date.now();
    if (!split.current) {
      this.clearTimer();
      this.currentIdentity = '';
      this.inboundAppearedAt = 0;
      return;
    }

    const id = queueableFeedIdentity(split.current);
    const textLen = previewItemText(split.current).length;
    if (id !== this.currentIdentity) {
      this.currentIdentity = id;
      this.currentTextLen = textLen;
      this.previewStartedAt = now;
      this.lastGrowthAt = now;
      this.inboundAppearedAt = 0;
    } else if (textLen !== this.currentTextLen) {
      this.currentTextLen = textLen;
      this.lastGrowthAt = now;
    }

    if (pressureInbound(split.current, split.inbound)) {
      if (this.inboundAppearedAt === 0) {
        this.inboundAppearedAt = now;
      }
    } else {
      this.inboundAppearedAt = 0;
    }

    this.armTimer();
  }

  private armTimer(): void {
    this.clearTimer();
    const live = this.live();
    const items = this.items();
    const split = splitQueuedFeed(items, displayCommittedCount(items, this.committedCount()));
    const decision = decidePreviewCommit({
      live,
      items,
      current: split.current,
      inbound: split.inbound,
      now: Date.now(),
      previewStartedAt: this.previewStartedAt,
      lastGrowthAt: this.lastGrowthAt,
      inboundAppearedAt: this.inboundAppearedAt,
    });
    if (decision.action === 'flush') {
      this.committedCount.set(queueableItems(items).length);
      this.currentIdentity = '';
      this.inboundAppearedAt = 0;
      return;
    }
    if (decision.action === 'commit') {
      this.commitPreview();
      return;
    }
    if (decision.action === 'wait') {
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.armTimer();
      }, decision.delayMs);
    }
  }

  private commitPreview(): void {
    const items = this.items();
    const n = this.committedCount();
    const count = previewCommitCount(items, n);
    this.markSettling(committedItemIdentities(items, n, count));
    this.committedCount.set(displayCommittedCount(items, n + count));
    this.currentIdentity = '';
    this.inboundAppearedAt = 0;
    this.syncQueue(this.live(), items);
  }

  private markSettling(ids: readonly string[]): void {
    if (ids.length === 0) {
      return;
    }
    if (this.settleTimer != null) {
      clearTimeout(this.settleTimer);
    }
    this.settling.update((prev) => new Set([...prev, ...ids]));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settling.set(new Set());
    }, CHIP_SETTLE_MS);
  }

  private clearSettle(): void {
    if (this.settleTimer != null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.commitTimer != null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private scrollPreviewToBottom(): void {
    const el = this.previewBody()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
