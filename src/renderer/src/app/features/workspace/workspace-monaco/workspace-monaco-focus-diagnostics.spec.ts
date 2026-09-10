import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import type { LspEditorDiagnostic } from '@shared/index';
import { WorkspaceMonacoComponent } from './workspace-monaco';

type DiagnosticsHandoffHarness = {
  destroyed: boolean;
  focused: () => boolean;
  relativePath: () => string | null;
  activeModelKey: () => string | null;
  editor: { getModel: () => Monaco.editor.ITextModel | null };
  store: {
    getModel: (key: string) => Monaco.editor.ITextModel | undefined;
    diagnosticsByModelKey: Map<string, LspEditorDiagnostic[]>;
  };
  zone: { run: <T>(fn: () => T) => T };
  setActiveDiagnostics: ReturnType<typeof vi.fn>;
  publishCachedDiagnosticsForActiveEditor: () => void;
};

function harness(cached: LspEditorDiagnostic[] = []): DiagnosticsHandoffHarness {
  const model = {} as Monaco.editor.ITextModel;
  const subject = Object.create(WorkspaceMonacoComponent.prototype) as DiagnosticsHandoffHarness;
  Object.assign(subject, {
    destroyed: false,
    focused: () => true,
    relativePath: () => 'src/a.ts',
    activeModelKey: () => 'rel:src/a.ts',
    editor: { getModel: () => model },
    store: {
      getModel: () => model,
      diagnosticsByModelKey: new Map([['rel:src/a.ts', cached]]),
    },
    zone: { run: <T>(fn: () => T) => fn() },
    setActiveDiagnostics: vi.fn(),
  });
  return subject;
}

describe('WorkspaceMonacoComponent Problems-panel focus handoff', () => {
  it('force-publishes an empty cached result when a grid slot regains focus', () => {
    const subject = harness();

    subject.publishCachedDiagnosticsForActiveEditor();

    expect(subject.setActiveDiagnostics).toHaveBeenCalledWith('src/a.ts', [], true);
  });

  it('publishes cached diagnostics immediately before the async refresh', () => {
    const diagnostic: LspEditorDiagnostic = {
      relative_path: 'src/a.ts',
      message: 'Example error',
      severity: 'error',
      severity_value: 1,
      code: 'example',
      source: 'test',
      line: 1,
      character: 1,
      end_line: 1,
      end_character: 2,
    };
    const subject = harness([diagnostic]);

    subject.publishCachedDiagnosticsForActiveEditor();

    expect(subject.setActiveDiagnostics).toHaveBeenCalledWith('src/a.ts', [diagnostic], true);
  });
});
