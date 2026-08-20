import type * as Monaco from 'monaco-editor';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

export const JAVA_SHOW_REFERENCES_COMMAND = 'java.show.references';
export const JAVA_SHOW_IMPLEMENTATIONS_COMMAND = 'java.show.implementations';

const JAVA_SHOW_LOCATION_COMMANDS = new Set([
  JAVA_SHOW_REFERENCES_COMMAND,
  JAVA_SHOW_IMPLEMENTATIONS_COMMAND,
]);

export interface JavaShowNavigatePayload {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
}

export interface ClaraJavaShowOrigin {
  readonly relativePath: string;
  readonly position: Monaco.IPosition;
}

export interface ClaraJavaShowLocation {
  readonly relativePath: string;
  readonly range: Monaco.IRange;
}

export interface ParsedJavaShowLocationsArgs {
  readonly origin: ClaraJavaShowOrigin | null;
  readonly locations: readonly ClaraJavaShowLocation[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseOrigin(raw: unknown): ClaraJavaShowOrigin | null {
  const rec = asRecord(raw);
  if (!rec) {
    return null;
  }
  const relativePath = typeof rec['relativePath'] === 'string' ? rec['relativePath'] : '';
  const pos = asRecord(rec['position']);
  if (!relativePath || !pos) {
    return null;
  }
  const lineNumber = pos['lineNumber'];
  const column = pos['column'];
  if (typeof lineNumber !== 'number' || typeof column !== 'number') {
    return null;
  }
  return { relativePath, position: { lineNumber, column } };
}

function parseLocation(raw: unknown): ClaraJavaShowLocation | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec['relativePath'] !== 'string') {
    return null;
  }
  const range = asRecord(rec['range']);
  if (!range) {
    return null;
  }
  const startLineNumber = range['startLineNumber'];
  const startColumn = range['startColumn'];
  const endLineNumber = range['endLineNumber'];
  const endColumn = range['endColumn'];
  if (
    typeof startLineNumber !== 'number' ||
    typeof startColumn !== 'number' ||
    typeof endLineNumber !== 'number' ||
    typeof endColumn !== 'number'
  ) {
    return null;
  }
  return {
    relativePath: rec['relativePath'],
    range: { startLineNumber, startColumn, endLineNumber, endColumn },
  };
}

/**
 * JDT code lenses send ``java.show.references`` / ``java.show.implementations``.
 * Clara rewrites arguments to ``[origin, locations]`` (workspace-relative).
 */
export function parseJavaShowLocationsCommandArgs(args: readonly unknown[]): ParsedJavaShowLocationsArgs {
  if (args.length >= 2 && Array.isArray(args[1])) {
    const locations: ClaraJavaShowLocation[] = [];
    for (const item of args[1]) {
      const loc = parseLocation(item);
      if (loc) {
        locations.push(loc);
      }
    }
    return { origin: parseOrigin(args[0]), locations };
  }
  return { origin: null, locations: [] };
}

function workspaceUri(api: typeof Monaco, relativePath: string): Monaco.Uri {
  return api.Uri.parse(`clara-workspace:///${encodeURI(normalizePathSlashes(relativePath))}`);
}

type CommandService = {
  executeCommand: (id: string, ...args: unknown[]) => unknown;
};

let commandServicePromise: Promise<CommandService | null> | null = null;

function getCommandService(): Promise<CommandService | null> {
  commandServicePromise ??= Promise.all([
    import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
    import('monaco-editor/esm/vs/platform/commands/common/commands.js'),
  ])
    .then(([ss, cmd]) => ss.StandaloneServices.get(cmd.ICommandService) as CommandService)
    .catch((err: unknown) => {
      console.warn('[workspace-monaco-java-code-lens] command service unavailable', err);
      return null;
    });
  return commandServicePromise;
}

function navigateTo(
  onNavigate: (payload: JavaShowNavigatePayload) => void,
  loc: ClaraJavaShowLocation,
): void {
  onNavigate({
    relativePath: loc.relativePath,
    line: loc.range.startLineNumber,
    column: loc.range.startColumn,
  });
}

export interface RegisterJavaShowLocationCommandsOptions {
  readonly monacoApi: typeof Monaco;
  readonly getEditor: () => Monaco.editor.IStandaloneCodeEditor | null;
  readonly onNavigateToWorkspaceFile: (payload: JavaShowNavigatePayload) => void;
}

/**
 * Monaco has no VS Code Java extension, so JDT ``java.show.*`` commands 404 unless registered.
 * Peek uses ``editor.action.peekLocations`` with ``clara-workspace`` URIs.
 */
export function registerJavaShowLocationCommands(
  opts: RegisterJavaShowLocationCommandsOptions,
): Monaco.IDisposable {
  const { monacoApi: api, getEditor, onNavigateToWorkspaceFile } = opts;

  const handler = (_accessor: unknown, ...args: unknown[]): void => {
    const parsed = parseJavaShowLocationsCommandArgs(args);
    if (parsed.locations.length === 1) {
      navigateTo(onNavigateToWorkspaceFile, parsed.locations[0]!);
      return;
    }
    const editor = getEditor();
    const model = editor?.getModel() ?? null;
    if (editor && model && parsed.locations.length > 1) {
      const resource = model.uri;
      const position = parsed.origin?.position ?? editor.getPosition() ?? { lineNumber: 1, column: 1 };
      const monacoLocs = parsed.locations.map((loc) => ({
        uri: workspaceUri(api, loc.relativePath),
        range: new api.Range(
          loc.range.startLineNumber,
          loc.range.startColumn,
          loc.range.endLineNumber,
          loc.range.endColumn,
        ),
      }));
      void getCommandService().then((cs) => {
        if (!cs) {
          navigateTo(onNavigateToWorkspaceFile, parsed.locations[0]!);
          return;
        }
        return cs.executeCommand('editor.action.peekLocations', resource, position, monacoLocs, 'peek');
      });
      return;
    }
    if (parsed.origin) {
      onNavigateToWorkspaceFile({
        relativePath: parsed.origin.relativePath,
        line: parsed.origin.position.lineNumber,
        column: parsed.origin.position.column,
      });
      void editor?.getAction('editor.action.referenceSearch.trigger')?.run();
    }
  };

  const disposables = [...JAVA_SHOW_LOCATION_COMMANDS].map((id) => api.editor.registerCommand(id, handler));
  return {
    dispose: () => {
      for (const d of disposables) {
        d.dispose();
      }
    },
  };
}
