import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import { normalizeLooseAtxHeadings } from './markdown-normalize';

describe('normalizeLooseAtxHeadings', () => {
  it('inserts required space after hashes for ###1 style headings', () => {
    expect(normalizeLooseAtxHeadings('###1\nbody')).toBe('### 1\nbody');
  });

  it('does not change headings that already have a space', () => {
    expect(normalizeLooseAtxHeadings('### 1\nbody')).toBe('### 1\nbody');
  });

  it('skips lines inside fenced code blocks', () => {
    const md = '```\n###1\n```\n###2';
    expect(normalizeLooseAtxHeadings(md)).toBe('```\n###1\n```\n### 2');
  });

  it('fixes headings after blockquote and list prefixes', () => {
    expect(normalizeLooseAtxHeadings('> ###1')).toBe('> ### 1');
    expect(normalizeLooseAtxHeadings('- ###1')).toBe('- ### 1');
    expect(normalizeLooseAtxHeadings('1. ###1')).toBe('1. ### 1');
  });

  it('round-trips through marked to real heading elements', () => {
    const m = new Marked();
    const html = m.parse(normalizeLooseAtxHeadings('###1\n\npara'), { async: false }) as string;
    expect(html).toContain('<h3>1</h3>');
    expect(html).not.toContain('<p>###1</p>');
  });
});
