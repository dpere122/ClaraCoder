import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  Injector,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import type { FileDiffPayload } from '@shared/index';
import type * as Monaco from 'monaco-editor';
import {
  firstChangedLineInHunk,
  mergedContentForDiffPreview,
  originalContentForDiffPreview,
} from '../diff-rebuild';

let monacoLoadPromise: Promise<typeof import('monaco-editor')> | null = null;

function loadMonaco(): Promise<typeof import('monaco-editor')> {
  monacoLoadPromise ??= import('monaco-editor').then(async (monacoApi) => {
    const { ensureMonacoFindWidgetSafe } = await import('../../../../monaco-find-safety');
    await ensureMonacoFindWidgetSafe();
    return monacoApi;
  });
  return monacoLoadPromise;
}

function hitlMonacoTheme(): 'vs' | 'vs-dark' {
  if (typeof document === 'undefined') {
    return 'vs-dark';
  }
  return document.documentElement.getAttribute('data-bs-theme') === 'light' ? 'vs' : 'vs-dark';
}

@Component({
  selector: 'app-diff-monaco-preview',
  standalone: true,
  template: `<div #host class="diff-monaco-host" role="region" aria-label="Diff preview"></div>`,
  styleUrl: './diff-monaco-preview.css',
})
export class DiffMonacoPreviewComponent implements OnDestroy {
  readonly payload = input.required<FileDiffPayload>();
  readonly acceptedHunks = input.required<ReadonlySet<number>>();
  readonly skippedHunks = input.required<ReadonlySet<number>>();
  readonly focusHunk = input<number | null>(null);
  readonly stacked = input(false);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly inj = inject(Injector);

  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private originalModel: Monaco.editor.ITextModel | null = null;
  private modifiedModel: Monaco.editor.ITextModel | null = null;
  private mountedPayloadKey = '';
  private monacoApi: typeof Monaco | null = null;
  private mounting = false;
  private disposed = false;

  constructor() {
    effect(() => {
      this.payload();
      this.acceptedHunks();
      this.skippedHunks();
      this.stacked();
      untracked(() => {
        afterNextRender(() => void this.ensureMounted(), { injector: this.inj });
      });
    });

    effect(() => {
      const hunk = this.focusHunk();
      untracked(() => {
        afterNextRender(() => this.revealFocusHunk(hunk), { injector: this.inj });
      });
    });
  }

  ngOnDestroy(): void {
    this.disposed = true;
    this.disposeEditor();
  }

  private payloadKey(payload: FileDiffPayload): string {
    return `${payload.relativePath}|${payload.baseSha256 ?? ''}|${payload.rows.length}|${payload.fullNewContent.length}`;
  }

  private languageId(payload: FileDiffPayload): string {
    const lang = payload.language?.trim();
    return lang || 'plaintext';
  }

  private originalText(payload: FileDiffPayload): string {
    return originalContentForDiffPreview(payload);
  }

  private modifiedText(payload: FileDiffPayload): string {
    return mergedContentForDiffPreview(payload, this.acceptedHunks(), this.skippedHunks());
  }

  private diffEditorOptions(stacked: boolean): Monaco.editor.IDiffEditorConstructionOptions {
    return {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      folding: false,
      glyphMargin: false,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderSideBySide: !stacked,
      wordWrap: 'on',
      fontSize: 12,
      lineNumbers: 'on',
    };
  }

  private async ensureMounted(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.diffEditor) {
      this.syncModels();
      return;
    }
    if (this.mounting) {
      return;
    }
    this.mounting = true;
    try {
      const monacoApi = await loadMonaco();
      if (this.disposed || this.diffEditor) {
        return;
      }
      this.monacoApi = monacoApi;
      const payload = this.payload();
      const theme = hitlMonacoTheme();
      monacoApi.editor.setTheme(theme);

      const hostEl = this.host().nativeElement;
      this.mountedPayloadKey = this.payloadKey(payload);
      this.diffEditor = monacoApi.editor.createDiffEditor(hostEl, {
        ...this.diffEditorOptions(this.stacked()),
        theme,
      });

      const path = payload.relativePath;
      this.originalModel = monacoApi.editor.createModel(
        this.originalText(payload),
        this.languageId(payload),
        monacoApi.Uri.parse(`hitl-diff-org://${encodeURI(path)}`),
      );
      this.modifiedModel = monacoApi.editor.createModel(
        this.modifiedText(payload),
        this.languageId(payload),
        monacoApi.Uri.parse(`hitl-diff-mod://${encodeURI(path)}`),
      );
      this.diffEditor.setModel({
        original: this.originalModel,
        modified: this.modifiedModel,
      });
      this.diffEditor.layout();
      this.revealFocusHunk(this.focusHunk());
    } finally {
      this.mounting = false;
    }
  }

  private syncModels(): void {
    if (!this.diffEditor || !this.originalModel || !this.modifiedModel || this.originalModel.isDisposed()) {
      return;
    }
    const payload = this.payload();
    const key = this.payloadKey(payload);
    if (key !== this.mountedPayloadKey) {
      this.disposeEditor();
      void this.ensureMounted();
      return;
    }

    this.diffEditor.updateOptions(this.diffEditorOptions(this.stacked()));

    const original = this.originalText(payload);
    if (this.originalModel.getValue() !== original) {
      this.originalModel.setValue(original);
    }
    const modified = this.modifiedText(payload);
    if (this.modifiedModel.getValue() !== modified) {
      this.modifiedModel.setValue(modified);
    }
    this.diffEditor.layout();
  }

  private revealFocusHunk(hunk: number | null): void {
    if (hunk == null || !this.diffEditor) {
      return;
    }
    const line = firstChangedLineInHunk(this.payload(), hunk, 'modified');
    this.diffEditor.getModifiedEditor().revealLineInCenter(line);
  }

  private disposeEditor(): void {
    this.diffEditor?.dispose();
    this.diffEditor = null;
    if (this.originalModel && !this.originalModel.isDisposed()) {
      this.originalModel.dispose();
    }
    this.originalModel = null;
    if (this.modifiedModel && !this.modifiedModel.isDisposed()) {
      this.modifiedModel.dispose();
    }
    this.modifiedModel = null;
    this.mountedPayloadKey = '';
  }
}
