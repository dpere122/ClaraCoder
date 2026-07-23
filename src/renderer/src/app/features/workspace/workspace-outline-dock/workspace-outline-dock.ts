import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  EditorOutlineComponent,
  type EditorOutlineSymbol,
} from '../editor-outline/editor-outline';

@Component({
  selector: 'app-workspace-outline-dock',
  standalone: true,
  imports: [CommonModule, EditorOutlineComponent],
  templateUrl: './workspace-outline-dock.html',
  styleUrl: './workspace-outline-dock.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceOutlineDockComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly symbols = input<readonly EditorOutlineSymbol[]>([]);
  readonly relativePath = input<string | null>(null);
  readonly visible = input(false);

  readonly revealSymbol = output<EditorOutlineSymbol>();

  readonly expanded = signal(false);
  readonly panelHeightPx = signal(140);

  private panelDrag: { startY: number; startH: number } | null = null;
  private panelDragListenersActive = false;
  private destroyed = false;

  private readonly boundPanelDragMove = (e: MouseEvent) => this.onResizeHandleMove(e);
  private readonly boundPanelDragUp = () => this.endPanelDrag();

  readonly symbolCount = computed(() => this.countSymbols(this.symbols()));

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.endPanelDrag();
    });
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected onResizeHandleDown(ev: MouseEvent): void {
    if (!this.expanded()) {
      return;
    }
    ev.preventDefault();
    this.endPanelDrag();
    this.panelDrag = { startY: ev.clientY, startH: this.panelHeightPx() };
    this.panelDragListenersActive = true;
    window.addEventListener('mousemove', this.boundPanelDragMove);
    window.addEventListener('mouseup', this.boundPanelDragUp);
  }

  protected onOutlineReveal(sym: EditorOutlineSymbol): void {
    this.revealSymbol.emit(sym);
  }

  private onResizeHandleMove(ev: MouseEvent): void {
    if (this.destroyed) {
      return;
    }
    const drag = this.panelDrag;
    if (!drag) {
      return;
    }
    const delta = drag.startY - ev.clientY;
    const next = Math.min(560, Math.max(80, drag.startH + delta));
    this.panelHeightPx.set(next);
  }

  private endPanelDrag(): void {
    if (!this.panelDragListenersActive) {
      this.panelDrag = null;
      return;
    }
    window.removeEventListener('mousemove', this.boundPanelDragMove);
    window.removeEventListener('mouseup', this.boundPanelDragUp);
    this.panelDragListenersActive = false;
    this.panelDrag = null;
  }

  private countSymbols(symbols: readonly EditorOutlineSymbol[]): number {
    let total = 0;
    for (const sym of symbols) {
      total += 1;
      if (sym.children?.length) {
        total += this.countSymbols(sym.children);
      }
    }
    return total;
  }
}
