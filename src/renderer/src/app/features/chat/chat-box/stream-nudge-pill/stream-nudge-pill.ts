import {
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import {
  isNudgeStreamingPreview,
  nudgePillLabel,
  nudgePillState,
  resolveNudgePillExpanded,
} from './stream-nudge-pill-state';

@Component({
  selector: 'app-stream-nudge-pill',
  standalone: true,
  imports: [StreamToolPillComponent],
  templateUrl: './stream-nudge-pill.html',
  styleUrl: './stream-nudge-pill.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamNudgePillComponent {
  readonly text = input.required<string>();
  readonly live = input(false);
  /** True while this nudge preview is the latest live feed event. */
  readonly active = input(false);

  private readonly userOverride = signal<boolean | null>(null);
  private readonly previewBody = viewChild<ElementRef<HTMLElement>>('previewBody');

  readonly label = computed(() => nudgePillLabel(this.live(), this.active()));
  readonly pillState = computed(() => nudgePillState(this.live(), this.active()));
  readonly expanded = computed(() =>
    resolveNudgePillExpanded(this.live(), this.active(), this.userOverride()),
  );
  readonly showPreview = computed(() =>
    isNudgeStreamingPreview(this.live(), this.active(), this.userOverride()),
  );

  constructor() {
    effect(() => {
      this.text();
      const open = this.showPreview();
      untracked(() => {
        if (!open) {
          return;
        }
        queueMicrotask(() => this.scrollPreviewToBottom());
        requestAnimationFrame(() => this.scrollPreviewToBottom());
      });
    });
  }

  toggle(): void {
    this.userOverride.set(!this.expanded());
  }

  private scrollPreviewToBottom(): void {
    const el = this.previewBody()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
