import { Component, ViewEncapsulation, input } from '@angular/core';
import { isActiveLiveThought, type TurnFeedItem } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import { MarkdownPipe } from '../markdown.pipe';
import { StreamThoughtPillComponent } from '../stream-thought-pill/stream-thought-pill';

@Component({
  selector: 'app-stream-turn-feed',
  standalone: true,
  imports: [AuxStreamToolPartComponent, MarkdownPipe, StreamThoughtPillComponent],
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

  readonly isActiveThought = isActiveLiveThought;

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
}
