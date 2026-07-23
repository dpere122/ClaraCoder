import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { LspEditorDiagnostic } from '@shared/index';

@Component({
  selector: 'app-editor-problems',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './editor-problems.html',
  styleUrl: './editor-problems.css',
})
export class EditorProblemsComponent {
  readonly diagnostics = input<readonly LspEditorDiagnostic[]>([]);
  readonly relativePath = input<string | null>(null);

  readonly revealDiagnostic = output<LspEditorDiagnostic>();

  protected severityClass(d: LspEditorDiagnostic): string {
    switch (d.severity_value) {
      case 1:
        return 'editor-problems__severity--error';
      case 2:
        return 'editor-problems__severity--warning';
      case 3:
        return 'editor-problems__severity--info';
      default:
        return 'editor-problems__severity--hint';
    }
  }

  protected severityLabel(d: LspEditorDiagnostic): string {
    return d.severity || 'issue';
  }

  protected onRowClick(d: LspEditorDiagnostic): void {
    this.revealDiagnostic.emit(d);
  }
}
