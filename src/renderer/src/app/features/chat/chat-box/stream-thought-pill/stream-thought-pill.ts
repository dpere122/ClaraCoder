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
import { formatThoughtDuration } from '@shared/index';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import {
  isThoughtStreamingPreview,
  resolveThoughtPillExpanded,
  thoughtPillLabel,
  thoughtPillState,
} from './stream-thought-pill-state';

@Component({
  selector: 'app-stream-thought-pill',
  standalone: true,
  imports: [StreamToolPillComponent],
  templateUrl: './stream-thought-pill.html',
  styleUrl: './stream-thought-pill.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamThoughtPillComponent {
  readonly text = input.required<string>();
  /** How long the model thought (`Thought · 12s`); unset on older turns. */
  readonly durationMs = input<number | undefined>(undefined);
  readonly live = input(false);
  /** True while this thought is the latest live feed event. */
  readonly active = input(false);

  private readonly userOverride = signal<boolean | null>(null);
  private readonly previewBody = viewChild<ElementRef<HTMLElement>>('previewBody');

  readonly label = computed(() => thoughtPillLabel(this.live(), this.active()));
  readonly pillState = computed(() => thoughtPillState(this.live(), this.active()));
  readonly duration = computed(() => {
    const ms = this.durationMs();
    return ms === undefined ? '' : formatThoughtDuration(ms);
  });
  readonly expanded = computed(() =>
    resolveThoughtPillExpanded(this.live(), this.active(), this.userOverride()),
  );
  readonly showPreview = computed(() =>
    isThoughtStreamingPreview(this.live(), this.active(), this.userOverride()),
  );

  constructor() {
    effect(() => {
      this.text();
      this.showPreview();
      untracked(() => {
        queueMicrotask(() => this.scrollPreviewToBottom());
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
