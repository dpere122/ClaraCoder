import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { toolTrailStatusStreamTag, type StreamPart } from '@shared/index';
import { ToolPillGroupComponent } from './tool-pill-group';

function read(id: string, path: string, state: StreamPart['toolChainState']): StreamPart {
  return {
    streamTag: toolTrailStatusStreamTag(id),
    label: 'read_workspace_file',
    text: state === 'running' ? path : `File: ${path} Encoding: utf-8 Lines: 1-3 (of 3 in file)`,
    toolChainState: state,
    toolTarget: path,
  };
}

function render(parts: StreamPart[], live: boolean): HTMLElement {
  const fixture = TestBed.createComponent(ToolPillGroupComponent);
  fixture.componentRef.setInput('parts', parts);
  fixture.componentRef.setInput('live', live);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ToolPillGroupComponent', () => {
  it('glows the group name letter by letter while a child call runs', () => {
    const el = render([read('a', 'a.py', 'complete'), read('b', 'b.py', 'running')], true);
    const name = el.querySelector('.stream-tool-pill__name--shimmer');
    expect(name?.getAttribute('aria-label')).toBe('Read');
    expect(name?.querySelectorAll('.processing-text__letter').length).toBe(4);
  });

  it('stops glowing once every child finished', () => {
    const el = render([read('a', 'a.py', 'complete'), read('b', 'b.py', 'complete')], true);
    expect(el.querySelector('.stream-tool-pill__name--shimmer')).toBeNull();
    expect(el.querySelector('.stream-tool-pill__name')?.textContent).toBe('Read');
  });

  it('never glows in a saved turn, even with a stale running row', () => {
    const el = render([read('a', 'a.py', 'complete'), read('b', 'b.py', 'running')], false);
    expect(el.querySelector('.stream-tool-pill__name--shimmer')).toBeNull();
  });
});
