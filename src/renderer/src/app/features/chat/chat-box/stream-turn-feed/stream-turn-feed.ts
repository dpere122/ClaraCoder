import {
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { isActiveLiveBrief, type TurnFeedItem } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import { MarkdownPipe } from '../markdown.pipe';
import { StreamBriefPillComponent } from '../stream-brief-pill/stream-brief-pill';
import { StreamNudgePillComponent } from '../stream-nudge-pill/stream-nudge-pill';
import { StreamThoughtPillComponent } from '../stream-thought-pill/stream-thought-pill';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import {
  decidePreviewCommit,
  displayCommittedCount,
  feedItemDisplayRole,
  initialLiveCommittedCount,
  firstQueueableIdentity,
  previewCommitCount,
  previewItemText,
  previewQueueHeader,
  previewShowsBody as previewItemShowsBody,
  pressureInbound,
  queueableFeedIdentity,
  queueableItems,
  splitQueuedFeed,
  type FeedDisplayRole,
} from './stream-preview-queue';

@Component({
  selector: 'app-stream-turn-feed',
  standalone: true,
  imports: [
    AuxStreamToolPartComponent,
    MarkdownPipe,
    StreamBriefPillComponent,
    StreamNudgePillComponent,
    StreamThoughtPillComponent,
    StreamToolPillComponent,
  ],
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

  readonly displayCommitted = computed(() => displayCommittedCount(this.items(), this.committedCount()));

  readonly previewHeader = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return split.current ? previewQueueHeader(split.current, split.inbound) : '';
  });

  readonly previewShowsBody = computed(() => {
    const split = splitQueuedFeed(this.items(), this.displayCommitted());
    return previewItemShowsBody(split.current);
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.clearTimer());

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
  }

  itemRole(index: number, committedCount = this.displayCommitted()): FeedDisplayRole {
    return feedItemDisplayRole(this.items(), index, committedCount, this.live());
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

  briefIsGenerating(index: number): boolean {
    return isActiveLiveBrief(this.items(), index, this.live());
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
    this.committedCount.set(displayCommittedCount(items, n + previewCommitCount(items, n)));
    this.currentIdentity = '';
    this.inboundAppearedAt = 0;
    this.syncQueue(this.live(), items);
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
