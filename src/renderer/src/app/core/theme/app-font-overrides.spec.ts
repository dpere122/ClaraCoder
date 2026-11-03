import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppFontOverrides } from './app-font-overrides';

/** Stands in for canvas text metrics: each font maps to the width of `’` at 100px. */
function stubQuoteWidths(widths: Record<string, number>): void {
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext(): { font: string; measureText: () => { width: number } } {
        return {
          font: '',
          measureText(this: { font: string }) {
            return { width: widths[this.font.replace('100px ', '')] ?? 22 };
          },
        };
      }
    },
  );
}

function apply(uiFontFamily: string): string {
  applyAppFontOverrides({ uiFontSizeRem: 1, uiFontFamily, codeFontFamily: '' });
  return document.documentElement.style.getPropertyValue('--t-font-ui-override');
}

describe('applyAppFontOverrides UI font', () => {
  let previousStyle: string;

  beforeEach(() => {
    previousStyle = document.documentElement.style.cssText;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.cssText = previousStyle;
  });

  it('borrows narrow quotes for a font that draws them a full em wide', () => {
    stubQuoteWidths({ '"Microsoft Tai Le", sans-serif': 100 });
    expect(apply('"Microsoft Tai Le", sans-serif')).toBe('"Clara Narrow Quotes", "Microsoft Tai Le", sans-serif');
  });

  it('keeps a proportional font as chosen', () => {
    stubQuoteWidths({ '"Segoe UI"': 23 });
    expect(apply('"Segoe UI"')).toBe('"Segoe UI"');
  });

  it('keeps a monospace font as chosen', () => {
    stubQuoteWidths({ '"JetBrains Mono"': 60 });
    expect(apply('"JetBrains Mono"')).toBe('"JetBrains Mono"');
  });

  it('keeps the chosen font when text cannot be measured', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(apply('"Microsoft Tai Le"')).toBe('"Microsoft Tai Le"');
  });

  it('clears the override when no font is chosen', () => {
    stubQuoteWidths({});
    apply('"Segoe UI"');
    expect(apply('  ')).toBe('');
  });
});
