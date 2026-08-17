import { describe, expect, it } from 'vitest';
import {
  consumeOsc7CwdChunk,
  cwdFromOsc7Payload,
  extractOsc7CwdFromChunk,
  folderNameFromCwd,
  ptyTabIsExitedTitle,
  ptyTabTitleFromCwd,
} from './terminal-tab-title';

describe('folderNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(folderNameFromCwd('/home/daniel-dev/Documents/ClaraCoder')).toBe('ClaraCoder');
    expect(folderNameFromCwd('/home/daniel-dev/Documents/ClaraCoder/src')).toBe('src');
  });

  it('strips trailing slashes', () => {
    expect(folderNameFromCwd('/tmp/project/')).toBe('project');
  });

  it('handles Windows paths', () => {
    expect(folderNameFromCwd('C:\\Users\\dev\\ClaraCoder')).toBe('ClaraCoder');
    expect(folderNameFromCwd('C:\\Users\\dev\\ClaraCoder\\')).toBe('ClaraCoder');
  });

  it('returns / for the unix root', () => {
    expect(folderNameFromCwd('/')).toBe('/');
    expect(folderNameFromCwd('///')).toBe('/');
  });

  it('returns empty for blank input', () => {
    expect(folderNameFromCwd('')).toBe('');
    expect(folderNameFromCwd('   ')).toBe('');
  });
});

describe('ptyTabTitleFromCwd', () => {
  it('uses the folder name', () => {
    expect(ptyTabTitleFromCwd('/tmp/ClaraCoder')).toBe('ClaraCoder');
  });

  it('falls back to Terminal when cwd is empty', () => {
    expect(ptyTabTitleFromCwd('')).toBe('Terminal');
  });

  it('appends exited suffix', () => {
    expect(ptyTabTitleFromCwd('/tmp/ClaraCoder', true)).toBe('ClaraCoder (exited)');
  });
});

describe('ptyTabIsExitedTitle', () => {
  it('detects the exited suffix', () => {
    expect(ptyTabIsExitedTitle('ClaraCoder (exited)')).toBe(true);
    expect(ptyTabIsExitedTitle('ClaraCoder')).toBe(false);
  });
});

describe('cwdFromOsc7Payload', () => {
  it('parses file URLs with a host', () => {
    expect(cwdFromOsc7Payload('file://localhost/tmp/project')).toBe('/tmp/project');
  });

  it('parses file URLs without a host', () => {
    expect(cwdFromOsc7Payload('file:///home/dev/src')).toBe('/home/dev/src');
  });

  it('returns null for non-file payloads', () => {
    expect(cwdFromOsc7Payload('http://example.com/x')).toBeNull();
  });
});

describe('extractOsc7CwdFromChunk', () => {
  it('reads OSC 7 terminated with BEL', () => {
    expect(extractOsc7CwdFromChunk('\x1b]7;file://localhost/tmp/src\x07prompt$ ')).toBe('/tmp/src');
  });

  it('reads OSC 7 terminated with ST', () => {
    expect(extractOsc7CwdFromChunk('\x1b]7;file:///opt/app\x1b\\')).toBe('/opt/app');
  });

  it('returns the last cwd when a chunk contains more than one sequence', () => {
    const chunk = '\x1b]7;file:///tmp/a\x07\x1b]7;file:///tmp/b\x07';
    expect(extractOsc7CwdFromChunk(chunk)).toBe('/tmp/b');
  });

  it('returns null when the chunk has no OSC 7', () => {
    expect(extractOsc7CwdFromChunk('hello\n')).toBeNull();
  });
});

describe('consumeOsc7CwdChunk', () => {
  it('parses an OSC 7 sequence split across two chunks', () => {
    const first = consumeOsc7CwdChunk('', '\x1b]7;file:///tmp/pro');
    expect(first.cwd).toBeNull();
    expect(first.remainder).toBe('\x1b]7;file:///tmp/pro');

    const second = consumeOsc7CwdChunk(first.remainder, 'ject\x07prompt$ ');
    expect(second.cwd).toBe('/tmp/project');
    expect(second.remainder).toBe('');
  });

  it('keeps a trailing ESC as remainder', () => {
    const first = consumeOsc7CwdChunk('', 'text\x1b');
    expect(first.cwd).toBeNull();
    expect(first.remainder).toBe('\x1b');

    const second = consumeOsc7CwdChunk(first.remainder, ']7;file:///opt/app\x1b\\');
    expect(second.cwd).toBe('/opt/app');
  });
});
