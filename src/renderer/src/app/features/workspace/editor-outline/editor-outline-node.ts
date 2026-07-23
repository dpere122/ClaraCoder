import { Component, DestroyRef, effect, forwardRef, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { EditorOutlineBulkExpansion, EditorOutlineSymbol } from './editor-outline';

@Component({
  selector: 'app-editor-outline-node',
  standalone: true,
  imports: [CommonModule, forwardRef(() => EditorOutlineNodeComponent)],
  templateUrl: './editor-outline-node.html',
  styleUrl: './editor-outline-node.css',
})
export class EditorOutlineNodeComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly symbol = input.required<EditorOutlineSymbol>();
  readonly depth = input(0);
  readonly bulkExpansion = input<EditorOutlineBulkExpansion | null>(null);

  readonly revealSymbol = output<EditorOutlineSymbol>();

  protected readonly expanded = signal(true);

  private pendingRevealTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LABEL_CLICK_DELAY_MS = 220;

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelPendingReveal());

    effect(() => {
      const cmd = this.bulkExpansion();
      if (!cmd || !this.hasChildren(this.symbol())) {
        return;
      }
      this.expanded.set(cmd.expand);
    });
  }

  protected trackKey(sym: EditorOutlineSymbol): string {
    return `${sym.name}:${sym.range.startLineNumber}:${sym.range.startColumn}`;
  }

  protected hasChildren(sym: EditorOutlineSymbol): boolean {
    return (sym.children?.length ?? 0) > 0;
  }

  protected toggleExpanded(ev: MouseEvent): void {
    ev.stopPropagation();
    this.expanded.update((v) => !v);
  }

  protected onChevronDoubleClick(ev: MouseEvent): void {
    ev.stopPropagation();
  }

  protected onRowDoubleClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.cancelPendingReveal();
    if (!this.hasChildren(this.symbol())) {
      return;
    }
    this.expanded.update((v) => !v);
  }

  protected onLabelClick(sym: EditorOutlineSymbol): void {
    if (this.pendingRevealTimer != null) {
      clearTimeout(this.pendingRevealTimer);
    }
    this.pendingRevealTimer = setTimeout(() => {
      this.pendingRevealTimer = null;
      this.revealSymbol.emit(sym);
    }, EditorOutlineNodeComponent.LABEL_CLICK_DELAY_MS);
  }

  private cancelPendingReveal(): void {
    if (this.pendingRevealTimer != null) {
      clearTimeout(this.pendingRevealTimer);
      this.pendingRevealTimer = null;
    }
  }
}
