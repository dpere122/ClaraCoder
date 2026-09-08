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
  briefPillLabel,
  briefPillState,
  isBriefStreamingPreview,
  resolveBriefPillExpanded,
  shouldKeepBriefRendered,
} from './stream-brief-pill-state';

@Component({
  selector: 'app-stream-brief-pill',
  standalone: true,
  imports: [StreamToolPillComponent],
  templateUrl: './stream-brief-pill.html',
  styleUrl: './stream-brief-pill.css',
  encapsulation: ViewEncapsulation.None,
})
export class StreamBriefPillComponent {
  readonly text = input.required<string>();
  readonly live = input(false);
  /** True while this Clara brief is the latest live feed event. */
  readonly active = input(false);

  private readonly userOverride = signal<boolean | null>(null);
  private readonly previewBody = viewChild<ElementRef<HTMLElement>>('previewBody');

  readonly label = computed(() => briefPillLabel(this.live(), this.active()));
  readonly pillState = computed(() => briefPillState(this.live(), this.active()));
  readonly expanded = computed(() =>
    resolveBriefPillExpanded(this.live(), this.active(), this.userOverride(), this.text()),
  );
  readonly showPreview = computed(() =>
    isBriefStreamingPreview(this.live(), this.active(), this.userOverride()),
  );
  readonly keepRendered = computed(() =>
    shouldKeepBriefRendered(this.text(), this.userOverride(), this.live(), this.active()),
  );
  readonly panelOpen = computed(() => this.showPreview() || this.keepRendered());

  constructor() {
    effect(() => {
      this.text();
      const open = this.panelOpen();
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
