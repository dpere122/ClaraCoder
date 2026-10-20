import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { toolTrailStatusStreamTag, type StreamPart } from '@shared/index';
import { AuxStreamToolPartComponent } from './aux-stream-tool-part';

function edit(extra: Partial<StreamPart> = {}): StreamPart {
  return {
    streamTag: toolTrailStatusStreamTag('e1'),
    label: 'replace_workspace_lines',
    text: 'Updated `m.py` (line-range; 2 → 3 lines). --- Post-edit checks: no issues',
    toolChainState: 'complete',
    ...extra,
  };
}

function renderExpanded(part: StreamPart): HTMLElement {
  const fixture = TestBed.createComponent(AuxStreamToolPartComponent);
  fixture.componentRef.setInput('part', part);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  el.querySelector<HTMLButtonElement>('.stream-tool-pill')!.click();
  fixture.detectChanges();
  return el;
}

describe('AuxStreamToolPartComponent edit diff', () => {
  it('shows the call diff with line numbers when an edit pill opens', () => {
    const el = renderExpanded(edit({ toolDiff: ['@@ -1,2 +1,3 @@', ' a', '-b', '+B', '+c'].join('\n') }));
    expect(el.querySelector('.stream-tool-pill__meta')?.textContent).toContain('+2 −1');
    const added = [...el.querySelectorAll('.tool-edit-diff__row--add .tool-edit-diff__text')].map((n) => n.textContent);
    const removed = [...el.querySelectorAll('.tool-edit-diff__row--del .tool-edit-diff__text')].map((n) => n.textContent);
    expect(added).toEqual(['B', 'c']);
    expect(removed).toEqual(['b']);
    expect(el.querySelector('.tool-edit-diff__result')?.textContent).toContain('Post-edit checks');
    expect(el.querySelector('.aux-stream-tool-part__detail')).toBeNull();
  });

  it('falls back to the result text for edits saved before diffs existed', () => {
    const el = renderExpanded(edit());
    expect(el.querySelector('app-tool-edit-diff')).toBeNull();
    expect(el.querySelector('.aux-stream-tool-part__detail')?.textContent).toContain('Updated `m.py`');
  });
});
