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
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { StreamPart } from '@shared/index';
import { isReasoningAuxiliaryStreamTag } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import {
  type AuxiliaryPanelMode,
  auxiliaryPanelContentVisible,
  auxiliaryPanelShouldAutoScrollPreview,
  auxiliaryPanelViewportIsScrollable,
  initialAuxiliaryPanelMode,
  resolveAuxiliaryPanelModeForLive,
  toggleAuxiliaryPanelMode,
} from './auxiliary-stream-panel-modes';

export type { AuxiliaryPanelMode } from './auxiliary-stream-panel-modes';
export { initialAuxiliaryPanelMode, toggleAuxiliaryPanelMode } from './auxiliary-stream-panel-modes';

export const DEFAULT_AUXILIARY_STREAM_PANEL_TITLE = 'Model reasoning & tools';
export const PERSISTED_AUXILIARY_STREAM_PANEL_TITLE = 'Response details';

@Component({
  selector: 'app-auxiliary-stream-panel',
  standalone: true,
  imports: [AuxStreamToolPartComponent],
  templateUrl: './auxiliary-stream-panel.html',
  styleUrls: ['../stream-trail-panel-shared.css', './auxiliary-stream-panel.css'],
  encapsulation: ViewEncapsulation.None,
  host: {
    '[class.aux-stream-panel--pending-overflow]': 'pendingOverflowReveal()',
  },
})
export class AuxiliaryStreamPanelComponent {
  private readonly inj = inject(Injector);

  /** Multiplex segments (reasoning + delegated), already ordered. */
  readonly parts = input.required<StreamPart[]>();
  /** Live stream: parent may style timing (e.g. running tool row); panel is log-style, not a card. */
  readonly live = input(false);
  /** When set, tool rows use compact details beside the plan checklist. */
  readonly planPanelVisible = input(false);
  /** Header text; Clara handoff updates can replace the default reasoning/tools label. */
  readonly title = input(DEFAULT_AUXILIARY_STREAM_PANEL_TITLE);
  /** Hide the inline “Response details” row; role-label frames drive expand/collapse from the Clara chevron. */
  readonly hideHeaderToggle = input(false);
  /** Fires once when a live panel first takes layout height (overflow reveal / expand). */
  readonly overflowRevealed = output<void>();

  readonly mode = model<AuxiliaryPanelMode>('collapsed');
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private prevLive: boolean | undefined;
  private modeSyncedToLive = false;
  /** Live panel stays hidden until the viewport overflows (or the user expands). */
  private readonly overflowReady = signal(false);

  readonly hasCustomTitle = computed(() => this.title().trim() !== DEFAULT_AUXILIARY_STREAM_PANEL_TITLE);
  readonly contentVisible = computed(() => auxiliaryPanelContentVisible(this.mode()));
  readonly isExpanded = computed(() => this.mode() === 'expanded');
  readonly pendingOverflowReveal = computed(
    () => this.live() && !this.overflowReady(),
  );

  readonly isReasoning = isReasoningAuxiliaryStreamTag;

  trackPartId(part: StreamPart, index: number): string {
    return `${part.streamTag}:${part.label}:${index}`;
  }

  constructor() {
    effect(() => {
      const isLive = this.live();
      if (!this.modeSyncedToLive) {
        this.modeSyncedToLive = true;
        this.prevLive = isLive;
        this.mode.set(initialAuxiliaryPanelMode(isLive));
        this.overflowReady.set(!isLive);
        return;
      }
      const prevLive = this.prevLive;
      this.prevLive = isLive;
      if (prevLive !== isLive) {
        this.overflowReady.set(!isLive);
      }
      const next = resolveAuxiliaryPanelModeForLive(this.mode(), isLive, prevLive);
      if (next !== this.mode()) {
        this.mode.set(next);
      }
    });

    effect(() => {
      this.parts();
      const mode = this.mode();
      const isLive = this.live();
      if (!isLive) {
        return;
      }
      if (mode === 'expanded') {
        this.markOverflowReady();
        return;
      }
      if (this.overflowReady()) {
        return;
      }
      if (!auxiliaryPanelContentVisible(mode)) {
        return;
      }
      untracked(() => {
        afterNextRender(
          () => {
            this.syncOverflowReadyFromViewport();
          },
          { injector: this.inj },
        );
      });
    });

    effect(() => {
      this.parts();
      const mode = this.mode();
      if (!auxiliaryPanelShouldAutoScrollPreview(mode)) {
        return;
      }
      if (this.pendingOverflowReveal()) {
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

  private syncOverflowReadyFromViewport(): void {
    if (this.overflowReady()) {
      return;
    }
    const el = this.viewport()?.nativeElement;
    if (!el) {
      return;
    }
    if (auxiliaryPanelViewportIsScrollable(el.scrollHeight, el.clientHeight)) {
      this.markOverflowReady();
    }
  }

  private markOverflowReady(): void {
    if (this.overflowReady()) {
      return;
    }
    this.overflowReady.set(true);
    if (this.live()) {
      this.overflowRevealed.emit();
    }
  }
}
