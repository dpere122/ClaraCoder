import { NgTemplateOutlet } from '@angular/common';
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
import type { ChatThinkingDisplay, StreamPart, TurnFeedItem } from '@shared/index';
import { DEFAULT_CHAT_THINKING_DISPLAY, formatThoughtDuration } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import { MarkdownPipe } from '../markdown.pipe';
import { StreamNudgePillComponent } from '../stream-nudge-pill/stream-nudge-pill';
import { StreamThoughtPillComponent } from '../stream-thought-pill/stream-thought-pill';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import { ToolPillExpansion } from '../tool-pill-expansion';
import { ToolPillGroupComponent } from '../tool-pill-group/tool-pill-group';
import type { PillSpinnerKind } from '../tool-spinner-kind';
import {
  committedItemIndices,
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
import { activityLayout, activitySummary, type ActivitySummary } from './activity-blocks';
import {
  mergedRunCommandStatusIndices,
  settlingChipIndices,
  toolChipGroupParts,
  toolChipLayout,
} from './tool-chip-groups';

/** How long chips that just left the live preview play their settle animation (see the CSS). */
export const CHIP_SETTLE_MS = 520;

/** How often the compact `Thinking · 7s` pill's counter ticks. */
const THINKING_CLOCK_TICK_MS = 1000;

/**
 * Spinner the open preview hosts: thought header or compact thinking pill (`think`), or the
 * tool pill (read / write / run / web).
 */
export type HostedSpinnerKind = PillSpinnerKind;

@Component({
  selector: 'app-stream-turn-feed',
  standalone: true,
  imports: [
    AuxStreamToolPartComponent,
    MarkdownPipe,
    NgTemplateOutlet,
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
  /** `pill`: a live thought shows as a running `Thinking · 7s` pill instead of the preview box. */
  readonly thinkingDisplay = input<ChatThinkingDisplay>(DEFAULT_CHAT_THINKING_DISPLAY);

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

  /** Feed indices of items that just committed from the live preview to chips. */
  private readonly settling = signal<ReadonlySet<number>>(new Set());
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Wall clock for the compact thinking pill's counter; ticks only while that pill is open. */
  private readonly now = signal(Date.now());
  private clock: ReturnType<typeof setInterval> | null = null;
  /** Counter start for a thought without `thoughtStartedAt` (joined mid-turn on an older build). */
  private clockStartedAt = 0;

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

  /** Each stretch of work (no prose between them) wrapped in one activity block from its first row. */
  readonly activityLayout = computed(() => {
    const roles = this.displayRoles();
    return activityLayout(this.items(), (index) => roles[index] ?? 'hidden', this.live(), this.toolChipLayout().hidden);
  });

  /** Activity pill text by block lead index; counts only rows that landed (not the live preview or queue). */
  readonly activitySummaries = computed(() => {
    const items = this.items();
    const roles = this.displayRoles();
    const blocks = this.activityLayout().blocks;
    const out = new Map<number, ActivitySummary>();
    if (blocks.size === 0) {
      return out;
    }
    const merged = mergedRunCommandStatusIndices(items);
    for (const [lead, members] of blocks) {
      const landed = members.filter((index) => roles[index] === 'chip');
      out.set(lead, activitySummary(items, landed, merged));
    }
    return out;
  });

  private readonly toolPillExpansion = inject(ToolPillExpansion);
  /** Activity blocks the user opened or closed, by lead item key (see {@link trackItem}). */
  private readonly activityOverride = signal<ReadonlyMap<string, boolean>>(new Map());

  /** Chips (and group pills) that just took over from the live preview: they fade and settle in. */
  readonly settlingIndices = computed(() =>
    settlingChipIndices(this.settling(), this.toolChipLayout().groups),
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
    return previewItemShowsBody(split.current, this.thinkingDisplay());
  });

  /** The live thought currently shown as a compact `Thinking · 7s` pill, if any. */
  private readonly thinkingPillPart = computed<StreamPart | null>(() => {
    if (!this.live() || this.thinkingDisplay() !== 'pill') {
      return null;
    }
    const current = splitQueuedFeed(this.items(), this.displayCommitted()).current;
    return current?.kind === 'thought' ? current.part : null;
  });

  /** Seconds the compact thinking pill has been open (empty for tool previews). */
  readonly previewDuration = computed(() => {
    const part = this.thinkingPillPart();
    if (!part) {
      return '';
    }
    return formatThoughtDuration(this.now() - (part.thoughtStartedAt ?? this.clockStartedAt));
  });

  /**
   * Where the turn spinner lives right now: thought header, running tool or thinking pill, or
   * `null` (parent keeps it in the processing row).
   */
  readonly spinnerHost = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewSpinnerHost(this.live(), this.spinnerActive(), split.current, this.thinkingDisplay());
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
      this.stopClock();
    });

    effect(() => {
      const open = this.thinkingPillPart() !== null;
      untracked(() => {
        if (open && this.clock === null) {
          this.clockStartedAt = Date.now();
          this.now.set(this.clockStartedAt);
          this.clock = setInterval(() => this.now.set(Date.now()), THINKING_CLOCK_TICK_MS);
        } else if (!open) {
          this.stopClock();
        }
      });
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

  /**
   * Whether an activity block shows its timeline. Blocks start closed, working or not; the
   * closed pill names the live step instead (see {@link activityMeta}). Unless the user toggled
   * it, a block opens only when it holds a tool pill the user had open.
   */
  isActivityOpen(lead: number, members: readonly number[]): boolean {
    const items = this.items();
    const override = this.activityOverride().get(this.trackItem(items[lead]!, lead));
    if (override !== undefined) {
      return override;
    }
    return members.some((index) => {
      const item = items[index];
      return item?.kind === 'tool' && this.toolPillExpansion.isOpen(item.part.streamTag);
    });
  }

  toggleActivity(lead: number, members: readonly number[]): void {
    const key = this.trackItem(this.items()[lead]!, lead);
    const open = !this.isActivityOpen(lead, members);
    this.activityOverride.update((prev) => new Map(prev).set(key, open));
  }

  /** True when the block holds the open live preview (its spinner moves to the block pill while closed). */
  activityHostsPreview(members: readonly number[]): boolean {
    const roles = this.displayRoles();
    return members.some((index) => roles[index] === 'preview');
  }

  /** Activity pill meta: the counts, plus the live step (`Read — Thinking`) while a closed block hosts the preview. */
  activityMeta(meta: string, open: boolean, members: readonly number[]): string {
    const step = !open && this.activityHostsPreview(members) ? this.previewHeader() : '';
    return [meta, step].filter(Boolean).join(' · ');
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
    this.markSettling(committedItemIndices(items, n, count));
    this.committedCount.set(displayCommittedCount(items, n + count));
    this.currentIdentity = '';
    this.inboundAppearedAt = 0;
    this.syncQueue(this.live(), items);
  }

  private markSettling(indices: readonly number[]): void {
    if (indices.length === 0) {
      return;
    }
    if (this.settleTimer != null) {
      clearTimeout(this.settleTimer);
    }
    this.settling.update((prev) => new Set([...prev, ...indices]));
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

  private stopClock(): void {
    if (this.clock !== null) {
      clearInterval(this.clock);
      this.clock = null;
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
