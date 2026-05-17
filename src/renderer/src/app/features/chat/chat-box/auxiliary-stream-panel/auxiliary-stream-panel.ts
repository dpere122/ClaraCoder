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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { StreamPart } from '@shared/index';
import { isMoeAuxiliaryStreamTag, isShellStyleToolStreamTag, isToolTrailStatusStreamTag } from '@shared/index';
import { DelegatedShellTerminalComponent } from '../delegated-shell-terminal/delegated-shell-terminal';

export const DEFAULT_AUXILIARY_STREAM_PANEL_TITLE = 'Model reasoning & tools';

@Component({
  selector: 'app-auxiliary-stream-panel',
  standalone: true,
  imports: [DelegatedShellTerminalComponent],
  templateUrl: './auxiliary-stream-panel.html',
  styleUrl: './auxiliary-stream-panel.css',
  encapsulation: ViewEncapsulation.None,
})
export class AuxiliaryStreamPanelComponent {
  private readonly inj = inject(Injector);

  /** Multiplex segments (reasoning + delegated), already ordered. */
  readonly parts = input.required<StreamPart[]>();
  /** Live stream: parent may style timing (e.g. running tool row); panel is log-style, not a card. */
  readonly live = input(false);
  /** Header text; Clara handoff updates can replace the default reasoning/tools label. */
  readonly title = input(DEFAULT_AUXILIARY_STREAM_PANEL_TITLE);

  readonly expanded = signal(false);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');

  readonly hasCustomTitle = computed(() => this.title().trim() !== DEFAULT_AUXILIARY_STREAM_PANEL_TITLE);

  readonly isMoe = isMoeAuxiliaryStreamTag;
  readonly isShellTool = isShellStyleToolStreamTag;
  readonly isToolTrailStatus = isToolTrailStatusStreamTag;

  trackPartId(part: StreamPart, index: number): string {
    return `${part.streamTag}:${part.label}:${index}`;
  }

  constructor() {
    effect(() => {
      this.parts();
      const expanded = this.expanded();
      if (expanded) {
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

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }
}
