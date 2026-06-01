import { describe, expect, it } from 'vitest';
import { ansiTerminalOutputHtml } from './ansi-terminal-output';

describe('ansiTerminalOutputHtml', () => {
  it('escapes plain text without escape codes', () => {
    expect(ansiTerminalOutputHtml('hello <world>')).toBe('hello &lt;world&gt;');
  });

  it('renders basic foreground colors', () => {
    const html = ansiTerminalOutputHtml('\x1b[31mFAIL\x1b[0m ok');
    expect(html).toContain('<span class="ansi-fg-red">FAIL</span>');
    expect(html).toContain(' ok');
  });

  it('renders bold and green pytest-style output', () => {
    const html = ansiTerminalOutputHtml('\x1b[1;32mPASSED\x1b[0m tests/test_x.py');
    expect(html).toContain('class="ansi-bold ansi-fg-green"');
    expect(html).toContain('PASSED');
    expect(html).toContain(' tests/test_x.py');
  });

  it('renders 256-color foreground codes', () => {
    const html = ansiTerminalOutputHtml('\x1b[38;5;208morange\x1b[0m');
    expect(html).toContain('style="color:rgb(255, 135, 0)"');
    expect(html).toContain('orange');
  });

  it('strips cursor movement sequences', () => {
    expect(ansiTerminalOutputHtml('\x1b[2J\x1b[Hline')).toBe('line');
  });

  it('strips OSC window title sequences', () => {
    expect(ansiTerminalOutputHtml('\x1b]0;title\x07content')).toBe('content');
  });
});
