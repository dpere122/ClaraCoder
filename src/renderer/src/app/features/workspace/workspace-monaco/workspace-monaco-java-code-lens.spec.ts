import { parseJavaShowLocationsCommandArgs } from './workspace-monaco-java-code-lens';

describe('parseJavaShowLocationsCommandArgs', () => {
  it('parses rewritten Clara [origin, locations] arguments', () => {
    const out = parseJavaShowLocationsCommandArgs([
      { relativePath: 'src/App.java', position: { lineNumber: 5, column: 2 } },
      [
        {
          relativePath: 'src/Other.java',
          range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 11 },
        },
        { relativePath: 'skip-me' },
      ],
    ]);
    expect(out.origin).toEqual({
      relativePath: 'src/App.java',
      position: { lineNumber: 5, column: 2 },
    });
    expect(out.locations).toEqual([
      {
        relativePath: 'src/Other.java',
        range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 11 },
      },
    ]);
  });

  it('returns empty locations for raw JDT argument lists', () => {
    const out = parseJavaShowLocationsCommandArgs([
      'file:///tmp/App.java',
      { line: 0, character: 0 },
      [{ uri: 'file:///tmp/Other.java', range: { start: { line: 0, character: 0 } } }],
    ]);
    expect(out.origin).toBeNull();
    expect(out.locations).toEqual([]);
  });
});
