import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import type { LspEditorDiagnostic } from '@shared/index';

@Component({
  selector: 'app-editor-problems',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
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

  protected severityIcon(d: LspEditorDiagnostic): string {
    switch (d.severity_value) {
      case 1:
        return 'circle-x';
      case 2:
        return 'triangle-alert';
      default:
        return 'info';
    }
  }

  protected severityLabel(d: LspEditorDiagnostic): string {
    return d.severity || 'issue';
  }

  /** `source(code)` as the language server reports it, e.g. `css(unknownProperties)` or `ts(6133)`. */
  protected sourceLabel(d: LspEditorDiagnostic): string {
    const source = d.source?.trim() ?? '';
    const code = String(d.code ?? '').trim();
    if (source && code) {
      return `${source}(${code})`;
    }
    return source || code;
  }

  protected fileName(path: string): string {
    const slash = path.replace(/\\/g, '/').lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  protected dirName(path: string): string {
    const slash = path.replace(/\\/g, '/').lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : '';
  }

  protected onRowClick(d: LspEditorDiagnostic): void {
    this.revealDiagnostic.emit(d);
  }
}
