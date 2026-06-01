import { describe, expect, it } from 'vitest';
import {
  condenseToolTrailText,
  readToolPreviewBody,
  readToolPreviewTail,
  readToolPreviewTailForDisplay,
  readToolStatusHeadline,
  shellStreamPartBadgeMeta,
  shouldShowReadToolPreview,
  terminalTailPreview,
  toolStatusStreamPartMeta,
} from '../../shared/tool-trail-pill';

describe('condenseToolTrailText', () => {
  it('strips ANSI and collapses whitespace', () => {
    expect(condenseToolTrailText('\x1b[31mhello   world\x1b[0m')).toBe('hello world');
  });

  it('truncates long lines', () => {
    const long = 'a'.repeat(100);
    expect(condenseToolTrailText(long, 20)).toHaveLength(20);
    expect(condenseToolTrailText(long, 20).endsWith('…')).toBe(true);
  });
});

describe('terminalTailPreview', () => {
  it('returns the last non-empty lines', () => {
    const text = 'line1\n\nline2\nline3\n';
    expect(terminalTailPreview(text, 2)).toBe('line2\nline3');
  });
});

describe('shellStreamPartBadgeMeta', () => {
  it('shows running while live and incomplete', () => {
    expect(
      shellStreamPartBadgeMeta(
        { streamTag: 'tool-pytest', label: 'Pytest', text: 'output', runComplete: false },
        true,
      ),
    ).toBe('Running…');
  });

  it('shows exit code when complete', () => {
    expect(
      shellStreamPartBadgeMeta(
        { streamTag: 'tool-pytest', label: 'Pytest', text: 'ok', runComplete: true, exitCode: 0 },
        false,
      ),
    ).toBe('Exit 0');
  });
});

describe('readToolPreviewBody', () => {
  it('returns empty until the streamed body separator arrives', () => {
    expect(readToolPreviewBody('src/foo.py')).toBe('');
    expect(readToolStatusHeadline('src/foo.py')).toBe('src/foo.py');
  });

  it('returns only the streamed file body after the separator', () => {
    const text = 'src/foo.py\n\n── read_workspace_file ──\n  1 │ a\n  2 │ b\n';
    expect(readToolPreviewBody(text)).toBe('── read_workspace_file ──\n  1 │ a\n  2 │ b\n');
  });
});

describe('readToolPreviewTail', () => {
  it('returns the last lines of the read body for collapsed preview', () => {
    const text = 'src/foo.py\n\n── read_workspace_file ──\n  1 │ a\n  2 │ b\n  3 │ c\n';
    expect(readToolPreviewTail(text, 2)).toBe('  2 │ b\n  3 │ c');
  });
});

describe('readToolPreviewTailForDisplay', () => {
  it('falls back to headline tail before the stream body marker arrives', () => {
    expect(readToolPreviewTailForDisplay('src/foo.py\nline two', 1)).toBe('line two');
  });
});

describe('shouldShowReadToolPreview', () => {
  it('is true for headline-only read rows while streaming', () => {
    expect(shouldShowReadToolPreview('src/foo.py', 'read_workspace_file')).toBe(true);
  });

  it('is true when read body lines are present', () => {
    const text = 'src/foo.py\n\n── read_workspace_file ──\n  1 │ a\n';
    expect(shouldShowReadToolPreview(text, 'read_workspace_file')).toBe(true);
  });
});

describe('toolStatusStreamPartMeta', () => {
  it('prefers condensed detail text', () => {
    expect(
      toolStatusStreamPartMeta({
        streamTag: 'tool-trail:x',
        label: 'read_file',
        text: 'Reading src/main.ts',
        toolChainState: 'complete',
      }),
    ).toBe('Reading src/main.ts');
  });
});
