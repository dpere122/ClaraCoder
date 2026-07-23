import { Component, effect, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EditorOutlineNodeComponent } from './editor-outline-node';

export interface EditorOutlineSymbol {
  name: string;
  kind?: number;
  detail?: string;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  selectionRange: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  children?: EditorOutlineSymbol[];
}

export interface EditorOutlineBulkExpansion {
  expand: boolean;
  seq: number;
}

@Component({
  selector: 'app-editor-outline',
  standalone: true,
  imports: [CommonModule, EditorOutlineNodeComponent],
  templateUrl: './editor-outline.html',
  styleUrl: './editor-outline.css',
})
export class EditorOutlineComponent {
  readonly symbols = input<readonly EditorOutlineSymbol[]>([]);
  readonly relativePath = input<string | null>(null);

  readonly revealSymbol = output<EditorOutlineSymbol>();

  private bulkExpansionSeq = 0;
  protected readonly bulkExpansion = signal<EditorOutlineBulkExpansion | null>(null);
  /** Tracks whether the tree is in expand-all mode (toggle label + next click action). */
  protected readonly allExpanded = signal(true);

  constructor() {
    effect(() => {
      this.symbols();
      this.relativePath();
      this.allExpanded.set(true);
    });
  }

  protected trackKey(sym: EditorOutlineSymbol): string {
    return `${sym.name}:${sym.range.startLineNumber}:${sym.range.startColumn}`;
  }

  protected onSymbolClick(sym: EditorOutlineSymbol): void {
    this.revealSymbol.emit(sym);
  }

  protected toggleExpandAll(): void {
    const next = !this.allExpanded();
    this.allExpanded.set(next);
    this.bulkExpansion.set({ expand: next, seq: ++this.bulkExpansionSeq });
  }
}
