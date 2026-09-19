import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lucideAppProviders } from '../../../lucide-setup';
import {
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_DRAG_MIME,
} from '../../chat/chat-context-bar/chat-context-file';
import { chatFileTabId, workspaceChatFileTab } from '../app-chat-file-tabs';
import { EditorGridComponent, type EditorGridFileDrop } from './editor-grid';
import { singleSlotLayout, type EditorGridLayout } from './editor-grid-layout';

@Component({
  standalone: true,
  imports: [EditorGridComponent],
  template: `
    <app-editor-grid
      [layout]="layout()"
      [focusedSlotId]="focusedSlotId()"
      (layoutChange)="onLayoutChange($event)"
      (slotFocus)="focusedSlotId.set($event)"
      (fileDrop)="fileDrops.push($event)"
    >
      <ng-template #slotBody let-slot>
        <div class="body" [attr.data-test-slot]="slot.id">{{ slot.id }}</div>
      </ng-template>
    </app-editor-grid>
  `,
})
class HostComponent {
  readonly layout = signal<EditorGridLayout>(singleSlotLayout());
  readonly focusedSlotId = signal<string | null>(null);
  readonly changes: EditorGridLayout[] = [];
  readonly fileDrops: EditorGridFileDrop[] = [];

  onLayoutChange(layout: EditorGridLayout): void {
    this.changes.push(layout);
    this.layout.set(layout);
  }
}

type GridInternals = {
  onDragStarted(source: { slotId: string; tabId: string }): void;
  onDragMoved(ev: { x: number; y: number; source: { slotId: string; tabId: string } }): void;
  onDragEnded(): void;
  onDragDropped(ev: { source: { slotId: string; tabId: string }; overContainer: boolean }): void;
  dragPreview(): unknown;
};

describe('EditorGridComponent drag/drop', () => {
  const a = workspaceChatFileTab('a.ts');
  const b = workspaceChatFileTab('b.ts');
  let originalElementFromPoint: typeof document.elementFromPoint;

  beforeEach(() => {
    originalElementFromPoint = document.elementFromPoint;
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [...lucideAppProviders],
    });
  });

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
  });

  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    const host = fixture.componentInstance;
    const layout = singleSlotLayout([a, b], chatFileTabId(a));
    const slotId = layout.columns[0]!.slots[0]!.id;
    host.layout.set(layout);
    host.focusedSlotId.set(slotId);
    fixture.detectChanges();

    const body = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-editor-grid-slot-body="${slotId}"]`,
    ) as HTMLElement;
    expect(body).toBeTruthy();
    // jsdom has no layout: give the slot body a fake rect and route elementFromPoint to it.
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = vi.fn(() => body.firstElementChild ?? body) as typeof document.elementFromPoint;

    const grid = fixture.debugElement.query((d) => d.componentInstance instanceof EditorGridComponent)
      .componentInstance as unknown as GridInternals;
    return { fixture, host, grid, slotId };
  }

  it('splits the slot when a tab is released on an edge hotspot (ended fires before dropped)', () => {
    const { fixture, host, grid, slotId } = setup();
    const source = { slotId, tabId: chatFileTabId(b) };

    grid.onDragStarted(source);
    grid.onDragMoved({ x: 390, y: 150, source }); // right edge band
    fixture.detectChanges();
    expect(grid.dragPreview()).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).querySelector('.editor-grid__drop-overlay')).toBeTruthy();

    // CDK order: cdkDragEnded, then cdkDropListDropped.
    grid.onDragEnded();
    grid.onDragDropped({ source, overContainer: false });
    fixture.detectChanges();

    expect(host.changes).toHaveLength(1);
    const next = host.layout();
    expect(next.columns).toHaveLength(2);
    expect(next.columns[0]!.slots[0]!.tabs.map((t) => t.relativePath)).toEqual(['a.ts']);
    expect(next.columns[1]!.slots[0]!.tabs.map((t) => t.relativePath)).toEqual(['b.ts']);
    expect(host.focusedSlotId()).toBe(next.columns[1]!.slots[0]!.id);
    expect(grid.dragPreview()).toBeNull();
  });

  it('does not split when the drop lands on a tab strip (handled as reorder/move)', () => {
    const { fixture, host, grid, slotId } = setup();
    const source = { slotId, tabId: chatFileTabId(b) };

    grid.onDragStarted(source);
    grid.onDragMoved({ x: 390, y: 150, source });
    grid.onDragEnded();
    grid.onDragDropped({ source, overContainer: true });
    fixture.detectChanges();

    expect(host.changes).toHaveLength(0);
    expect(host.layout().columns).toHaveLength(1);
  });

  /** jsdom has no DragEvent: synthesize a bubbling event carrying `dataTransfer` + pointer coords. */
  function dispatchDrag(
    el: Element,
    type: 'dragenter' | 'dragover' | 'drop' | 'dragend',
    dt: Partial<DataTransfer> | null,
    x = 0,
    y = 0,
  ): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    Object.defineProperty(ev, 'clientX', { value: x });
    Object.defineProperty(ev, 'clientY', { value: y });
    el.dispatchEvent(ev);
    return ev;
  }

  function fileDragData(path: string, isDirectory = false): Partial<DataTransfer> {
    const data: Record<string, string> = {
      [WORKSPACE_TREE_DRAG_MIME]: path,
      [WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME]: isDirectory ? '1' : '0',
      'text/plain': path,
    };
    return {
      types: Object.keys(data),
      effectAllowed: isDirectory ? 'move' : 'copyMove',
      dropEffect: 'none',
      getData: (type: string) => data[type] ?? '',
    };
  }

  it('shows the split overlay for a nav-tree file drag and emits fileDrop with the side on drop', () => {
    const { fixture, host, slotId } = setup();
    const body = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-editor-grid-slot-body="${slotId}"]`,
    ) as HTMLElement;
    const inner = body.firstElementChild as HTMLElement; // stands in for Monaco's DOM
    const dt = fileDragData('C:/ws/src/c.ts');

    const enter = dispatchDrag(inner, 'dragenter', dt, 390, 150);
    fixture.detectChanges();
    expect(enter.defaultPrevented).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.editor-grid.is-dragging')).toBeTruthy();

    dispatchDrag(body, 'dragover', dt, 390, 150); // right edge band
    fixture.detectChanges();
    const label = (fixture.nativeElement as HTMLElement).querySelector('.editor-grid__drop-label');
    expect(label?.textContent?.trim()).toBe('Split right');
    expect(dt.dropEffect).toBe('copy');

    dispatchDrag(body, 'drop', dt, 390, 150);
    fixture.detectChanges();
    expect(host.fileDrops).toEqual([{ absolutePath: 'C:/ws/src/c.ts', slotId, side: 'right' }]);
    // Layout itself is owned by the shell for file drops.
    expect(host.changes).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).querySelector('.editor-grid__drop-overlay')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.editor-grid.is-dragging')).toBeNull();
  });

  it('emits fileDrop with side=null for a center drop and for drops on the tab strip', () => {
    const { fixture, host, slotId } = setup();
    const root = fixture.nativeElement as HTMLElement;
    const body = root.querySelector(`[data-editor-grid-slot-body="${slotId}"]`) as HTMLElement;
    const dt = fileDragData('C:/ws/src/c.ts');

    dispatchDrag(body, 'dragover', dt, 200, 150);
    fixture.detectChanges();
    expect(root.querySelector('.editor-grid__drop-label')?.textContent?.trim()).toBe('Open here');
    dispatchDrag(body, 'drop', dt, 200, 150);

    const strip = root.querySelector('app-editor-grid-tab-strip') as HTMLElement;
    dispatchDrag(strip, 'dragover', dt, 10, 10);
    dispatchDrag(strip, 'drop', dt, 10, 10);
    fixture.detectChanges();

    expect(host.fileDrops).toEqual([
      { absolutePath: 'C:/ws/src/c.ts', slotId, side: null },
      { absolutePath: 'C:/ws/src/c.ts', slotId, side: null },
    ]);
  });

  it('ignores folder drags and non-workspace drags', () => {
    const { fixture, host, slotId } = setup();
    const root = fixture.nativeElement as HTMLElement;
    const body = root.querySelector(`[data-editor-grid-slot-body="${slotId}"]`) as HTMLElement;

    const folder = fileDragData('C:/ws/src', true);
    const over = dispatchDrag(body, 'dragover', folder, 390, 150);
    fixture.detectChanges();
    expect(over.defaultPrevented).toBe(false);
    expect(root.querySelector('.editor-grid__drop-overlay')).toBeNull();
    dispatchDrag(body, 'drop', folder, 390, 150);

    const text: Partial<DataTransfer> = {
      types: ['text/plain'],
      effectAllowed: 'copyMove',
      getData: () => 'hello',
    };
    expect(dispatchDrag(body, 'dragover', text, 390, 150).defaultPrevented).toBe(false);
    dispatchDrag(body, 'drop', text, 390, 150);

    expect(host.fileDrops).toEqual([]);
  });

  it('keeps workspace-file drags away from editor DOM listeners (no path pasted into Monaco)', () => {
    const { fixture, host, slotId } = setup();
    const root = fixture.nativeElement as HTMLElement;
    const body = root.querySelector(`[data-editor-grid-slot-body="${slotId}"]`) as HTMLElement;
    const inner = body.firstElementChild as HTMLElement; // stands in for Monaco's DOM
    const seen: string[] = [];
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      inner.addEventListener(type, () => seen.push(type));
    }

    const file = fileDragData('C:/ws/src/c.ts');
    dispatchDrag(inner, 'dragenter', file, 200, 150);
    dispatchDrag(inner, 'dragover', file, 200, 150);
    dispatchDrag(inner, 'drop', file, 200, 150);
    fixture.detectChanges();
    expect(seen).toEqual([]);
    expect(host.fileDrops).toEqual([{ absolutePath: 'C:/ws/src/c.ts', slotId, side: null }]);

    // Monaco's own text drag (no workspace mime) still reaches the editor untouched.
    const text: Partial<DataTransfer> = { types: ['text/plain'], effectAllowed: 'copyMove', getData: () => 'x' };
    dispatchDrag(inner, 'dragover', text, 200, 150);
    dispatchDrag(inner, 'drop', text, 200, 150);
    expect(seen).toEqual(['dragover', 'drop']);
  });

  it('clears the file-drag overlay when the drag ends outside the grid', () => {
    const { fixture, slotId } = setup();
    const root = fixture.nativeElement as HTMLElement;
    const body = root.querySelector(`[data-editor-grid-slot-body="${slotId}"]`) as HTMLElement;
    const dt = fileDragData('C:/ws/src/c.ts');

    dispatchDrag(body, 'dragover', dt, 390, 150);
    fixture.detectChanges();
    expect(root.querySelector('.editor-grid__drop-overlay')).toBeTruthy();

    dispatchDrag(document.body, 'dragend', dt);
    fixture.detectChanges();
    expect(root.querySelector('.editor-grid__drop-overlay')).toBeNull();
    expect(root.querySelector('.editor-grid.is-dragging')).toBeNull();
  });

  it('clears a stale preview after a cancelled drag', async () => {
    const { fixture, grid, slotId } = setup();
    const source = { slotId, tabId: chatFileTabId(b) };

    grid.onDragStarted(source);
    grid.onDragMoved({ x: 390, y: 150, source });
    grid.onDragEnded();
    await Promise.resolve();
    fixture.detectChanges();

    expect(grid.dragPreview()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.editor-grid__drop-overlay')).toBeNull();
  });
});
