import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { toolTrailStatusStreamTag } from '@shared/index';
import { AuxStreamToolPartComponent } from '../aux-stream-tool-part/aux-stream-tool-part';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import { TOOL_GLYPH_IDS } from '../tool-spinner-kind';
import { ToolSpinnerComponent } from './tool-spinner';

function renderSpinner(kind: string, still = false): SVGSVGElement {
  const fixture = TestBed.createComponent(ToolSpinnerComponent);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('still', still);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('svg.tool-spinner')!;
}

/** The fractal tree drawn by `@default`, so a glyph without its own case would match it. */
const fallbackTree = renderSpinner('write').innerHTML;

describe('ToolSpinnerComponent', () => {
  it.each(TOOL_GLYPH_IDS)('draws its own %s glyph', (glyph) => {
    const svg = renderSpinner(glyph);
    expect(svg.querySelector('path, circle, rect, ellipse')).not.toBeNull();
    expect(svg.innerHTML).not.toBe(fallbackTree);
  });

  it('marks a still glyph so its motion stops', () => {
    expect(renderSpinner('search', true).classList).toContain('tool-spinner--still');
    expect(renderSpinner('search').classList).not.toContain('tool-spinner--still');
  });
});

describe('tool pill glyphs', () => {
  it("animates the running tool's glyph in a live pill", () => {
    const fixture = TestBed.createComponent(StreamToolPillComponent);
    fixture.componentRef.setInput('name', 'Fetch');
    fixture.componentRef.setInput('spinner', true);
    fixture.componentRef.setInput('spinnerKind', 'fetch');
    fixture.componentRef.setInput('icons', ['fetch']);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stream-tool-pill__spinner .ts-fetch')).not.toBeNull();
    expect(el.querySelector('.stream-tool-pill__icon')).toBeNull();
  });

  it("shows a finished tool's glyph still beside its name", () => {
    const fixture = TestBed.createComponent(AuxStreamToolPartComponent);
    fixture.componentRef.setInput('part', {
      streamTag: toolTrailStatusStreamTag('w'),
      label: 'web_search',
      text: 'angular signals',
      toolChainState: 'complete',
    });
    fixture.detectChanges();
    const icon = (fixture.nativeElement as HTMLElement).querySelector('.stream-tool-pill__icon svg');
    expect(icon?.classList).toContain('tool-spinner--still');
    expect(icon?.querySelector('.ts-meridian')).not.toBeNull();
  });
});
