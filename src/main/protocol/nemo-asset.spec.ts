/**
 * Tests for security/nemo-asset-svg — SVG sanitizer (strips active content
 * before serving workspace images over nemo-asset://).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  nativeImage: {},
  protocol: { handle: vi.fn() },
}));
vi.mock('../utils/assert-registered-workspace-dir', () => ({
  assertRegisteredWorkspaceDirectory: vi.fn(),
}));
vi.mock('../utils/workspace-safe-path', () => ({
  resolveSafeWorkspacePath: vi.fn(),
}));

import { sanitizeSvg } from './nemo-asset';

function svg(body: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, 'utf8');
}

function out(b: Buffer): string {
  return b.toString('utf8');
}

describe('sanitizeSvg — script / foreignObject', () => {
  it('strips a plain <script> block', () => {
    const s = svg('<script>alert(1)</script><rect/>');
    expect(out(sanitizeSvg(s))).not.toContain('script');
    expect(out(sanitizeSvg(s))).toContain('<rect');
  });

  it('strips a self-closing <script/>', () => {
    const s = svg('<script/>');
    expect(out(sanitizeSvg(s))).not.toContain('script');
  });

  it('strips namespaced <s:script> and <svg:foreignObject>', () => {
    const s = svg('<s:script>alert(1)</s:script><svg:foreignObject/>');
    const r = out(sanitizeSvg(s));
    expect(r).not.toContain('script');
    expect(r).not.toContain('foreignObject');
  });
});

describe('sanitizeSvg — event handlers', () => {
  it('strips onclick / ONCLICK / OnLoad (case-insensitive)', () => {
    const s = svg('<rect onclick="alert(1)" ONCLICK="alert(2)" OnLoad="x"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/onclick/i);
    expect(out(sanitizeSvg(s))).not.toMatch(/onload/i);
  });
});

describe('sanitizeSvg — URI schemes', () => {
  it('strips javascript: in href (quoted)', () => {
    const s = svg('<a href="javascript:alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });

  it('strips data: in xlink:href (quoted)', () => {
    const s = svg('<a xlink:href="data:text/html,<script>"/>');
    expect(out(sanitizeSvg(s))).not.toContain('data:');
  });

  it('strips unquoted javascript: in href', () => {
    const s = svg('<a href=javascript:alert(1)/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });

  it('strips entity-encoded javascript&#58; in href', () => {
    const s = svg('<a href="javascript&#58;alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/javascript/i);
  });

  it('strips &#106;avascript: in href', () => {
    const s = svg('<a href="&#106;avascript:alert(1)"/>');
    expect(out(sanitizeSvg(s))).not.toMatch(/javascript/i);
  });
});

describe('sanitizeSvg — SMIL', () => {
  it('strips attributeName targeting href (scripted URI animation)', () => {
    const s = svg('<animate attributeName="xlink:href" to="javascript:alert(1)"/>');
    const r = out(sanitizeSvg(s));
    expect(r).not.toMatch(/attributeName/i);
  });

  it('strips to/values/from/by carrying javascript:', () => {
    const s = svg('<animate to="javascript:alert(1)" values="javascript:alert(2)"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });
});

describe('sanitizeSvg — CSS url()', () => {
  it('strips url(javascript:…) and url(data:…)', () => {
    const s = svg('<rect style="background:url(javascript:alert(1))"/>');
    expect(out(sanitizeSvg(s))).not.toContain('javascript');
  });
});

describe('sanitizeSvg — benign preserved', () => {
  it('keeps a benign rect with a fill', () => {
    const s = svg('<rect width="10" height="10" fill="red"/>');
    const r = out(sanitizeSvg(s));
    expect(r).toContain('<rect');
    expect(r).toContain('fill="red"');
  });
});
