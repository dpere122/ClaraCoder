import { NgStyle, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  contentChild,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  type TemplateRef,
} from '@angular/core';
import { CdkDropListGroup } from '@angular/cdk/drag-drop';
import {
  dropActionFor,
  fileDropActionFor,
  hotspotForPoint,
  isWorkspaceFileDrag,
  previewCellsForZone,
  workspaceFilePathFromDrop,
  type EditorGridDragSource,
  type EditorGridDropAction,
  type EditorGridDropZone,
} from './editor-grid-drop';
import {
  adjustSizesAtGutter,
  moveTabToSlot,
  reorderTabInSlot,
  resizeColumns,
  resizeRows,
  slotById,
  splitSlotWithTab,
  type EditorGridColumn,
  type EditorGridLayout,
  type EditorGridSlot,
  type EditorGridSplitSide,
} from './editor-grid-layout';
import { EditorGridTabStripComponent, type EditorGridTabStripPointer } from './editor-grid-tab-strip';

/** Template context for the projected slot body (`<ng-template #slotBody let-slot let-focused="focused">`). */
export interface EditorGridSlotContext {
  $implicit: EditorGridSlot;
  focused: boolean;
}

export interface EditorGridDragPreview {
  slotId: string;
  zone: EditorGridDropZone;
  action: EditorGridDropAction;
}

/** A workspace file (from the nav tree) was dropped on a slot. `side` is null to open in place. */
export interface EditorGridFileDrop {
  absolutePath: string;
  slotId: string;
  side: EditorGridSplitSide | null;
}

const SLOT_ATTR = 'data-slot-id';

interface GutterDrag {
  pointerId: number;
  kind: 'column' | 'row';
  columnId: string | null;
  index: number;
  startPos: number;
  startSizes: number[];
  totalPx: number;
}

const SLOT_BODY_ATTR = 'data-editor-grid-slot-body';

/**
 * 3x3-capped editor grid: columns of slots, each slot with its own tab strip and a projected
 * body (Monaco / image viewer). Owns gutter resizing, cross-slot tab drag/drop and the
 * split-hotspot overlay; emits the resulting layout for the shell to store.
 */
@Component({
  selector: 'app-editor-grid',
  standalone: true,
  imports: [NgTemplateOutlet, NgStyle, CdkDropListGroup, EditorGridTabStripComponent],
  templateUrl: './editor-grid.html',
  styleUrl: './editor-grid.css',
})
export class EditorGridComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly layout = input.required<EditorGridLayout>();
  readonly focusedSlotId = input<string | null>(null);
  readonly unsavedKeys = input<ReadonlySet<string>>(new Set());
  readonly detachedKeys = input<ReadonlySet<string>>(new Set());

  readonly layoutChange = output<EditorGridLayout>();
  readonly slotFocus = output<string>();
  readonly tabSelect = output<{ slotId: string; tabId: string }>();
  readonly tabClose = output<{ slotId: string; tabId: string }>();
  readonly tabContextMenu = output<{ slotId: string; tabId: string; x: number; y: number }>();
  readonly fileDrop = output<EditorGridFileDrop>();

  protected readonly slotBody = contentChild.required<TemplateRef<EditorGridSlotContext>>('slotBody');

  /** CDK tab drag in progress. */
  private readonly tabDragging = signal(false);
  /** Native (workspace tree) file drag hovering the grid. */
  private readonly fileDragging = signal(false);
  protected readonly dragging = computed(() => this.tabDragging() || this.fileDragging());
  protected readonly dragPreview = signal<EditorGridDragPreview | null>(null);
  protected readonly previewCells = computed(() => {
    const p = this.dragPreview();
    return p ? new Set(previewCellsForZone(p.action.kind === 'noop' ? 'center' : p.zone)) : new Set<number>();
  });
  protected readonly cellIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  private gutterDrag: GutterDrag | null = null;
  /** Hotspot result carried from `cdkDragEnded` to the `cdkDropListDropped` that follows it. */
  private pendingPreview: EditorGridDragPreview | null = null;

  constructor() {
    // Workspace-file drags are intercepted in the *capture* phase so Monaco (a descendant of
    // the slot body, with its own dragover/drop listeners) never receives them. Otherwise the
    // first events reach the editor before the pointer-events swap applies and Monaco pastes
    // the dragged path as text into the active model.
    const el = this.host.nativeElement;
    const onOver = (e: Event) => this.onFileDragOver(e as DragEvent);
    const onDrop = (e: Event) => this.onFileDrop(e as DragEvent);
    el.addEventListener('dragenter', onOver, true);
    el.addEventListener('dragover', onOver, true);
    el.addEventListener('drop', onDrop, true);
    inject(DestroyRef).onDestroy(() => {
      el.removeEventListener('dragenter', onOver, true);
      el.removeEventListener('dragover', onOver, true);
      el.removeEventListener('drop', onDrop, true);
    });
  }

  protected columnStyle(index: number): string {
    const size = this.layout().columnSizes[index] ?? 1;
    return `${size} 1 0px`;
  }

  protected rowStyle(column: EditorGridColumn, index: number): string {
    const size = column.rowSizes[index] ?? 1;
    return `${size} 1 0px`;
  }

  protected slotContext(slot: EditorGridSlot): EditorGridSlotContext {
    return { $implicit: slot, focused: this.focusedSlotId() === slot.id };
  }

  protected isFocused(slot: EditorGridSlot): boolean {
    return this.focusedSlotId() === slot.id;
  }

  protected onSlotPointerDown(slotId: string): void {
    if (this.focusedSlotId() !== slotId) {
      this.slotFocus.emit(slotId);
    }
  }

  protected onTabSelect(slotId: string, tabId: string): void {
    this.tabSelect.emit({ slotId, tabId });
  }

  protected onTabClose(slotId: string, tabId: string): void {
    this.tabClose.emit({ slotId, tabId });
  }

  protected onTabContextMenu(slotId: string, ev: { tabId: string; x: number; y: number }): void {
    this.tabContextMenu.emit({ slotId, ...ev });
  }

  protected onReorder(slotId: string, ev: { fromIndex: number; toIndex: number }): void {
    this.layoutChange.emit(reorderTabInSlot(this.layout(), slotId, ev.fromIndex, ev.toIndex));
  }

  protected onMoveIn(slotId: string, ev: { source: EditorGridDragSource; index: number }): void {
    const next = moveTabToSlot(this.layout(), ev.source.slotId, ev.source.tabId, slotId, ev.index);
    this.layoutChange.emit(next);
    this.slotFocus.emit(slotId);
  }

  // ---------------------------------------------------------------------------
  // Drag hotspots
  // ---------------------------------------------------------------------------

  protected onDragStarted(_source: EditorGridDragSource): void {
    this.tabDragging.set(true);
    this.dragPreview.set(null);
  }

  protected onDragMoved(ev: EditorGridTabStripPointer): void {
    const hit = this.slotBodyAtPoint(ev.x, ev.y);
    if (!hit) {
      if (this.dragPreview()) {
        this.dragPreview.set(null);
      }
      return;
    }
    const zone = hotspotForPoint(hit.rect, ev.x, ev.y);
    const prev = this.dragPreview();
    if (prev && prev.slotId === hit.slotId && prev.zone === zone) {
      return;
    }
    const action = dropActionFor(this.layout(), ev.source, hit.slotId, zone);
    this.dragPreview.set({ slotId: hit.slotId, zone, action });
  }

  protected onDragDropped(ev: { source: EditorGridDragSource; overContainer: boolean }): void {
    // CDK emits `cdkDragEnded` *before* `cdkDropListDropped`, so the live preview may already
    // have been handed off to `pendingPreview` by `onDragEnded`.
    const preview = this.dragPreview() ?? this.pendingPreview;
    this.pendingPreview = null;
    this.dragPreview.set(null);
    if (ev.overContainer || !preview) {
      return;
    }
    this.applyDropAction(ev.source, preview.action);
  }

  protected onDragEnded(): void {
    this.tabDragging.set(false);
    const preview = this.dragPreview();
    if (!preview) {
      return;
    }
    // Keep the hotspot result available for the `dropped` event that follows synchronously;
    // clear it afterwards so a cancelled drag never leaves a stale overlay behind.
    this.pendingPreview = preview;
    this.dragPreview.set(null);
    queueMicrotask(() => {
      this.pendingPreview = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Native file drags (workspace tree -> slot)
  // ---------------------------------------------------------------------------

  /**
   * Capture-phase `dragenter` / `dragover` for a workspace file drag. Claims the event before
   * Monaco can (stopping propagation), marks the grid as dragging and mirrors the tab hotspot
   * overlay. Drags without the workspace mime (e.g. Monaco's own text drag) pass through.
   */
  private onFileDragOver(event: DragEvent): void {
    if (this.tabDragging() || !isWorkspaceFileDrag(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    if (!this.fileDragging()) {
      this.fileDragging.set(true);
    }
    const hit = this.slotHitForDragEvent(event);
    if (!hit) {
      if (this.dragPreview()) {
        this.dragPreview.set(null);
      }
      return;
    }
    const prev = this.dragPreview();
    if (prev && prev.slotId === hit.slotId && prev.zone === hit.zone) {
      return;
    }
    const action = fileDropActionFor(this.layout(), hit.slotId, hit.zone);
    this.dragPreview.set({ slotId: hit.slotId, zone: hit.zone, action });
  }

  /** Capture-phase `drop`: consumed here so Monaco never inserts the dragged path as text. */
  private onFileDrop(event: DragEvent): void {
    if (this.tabDragging() || !isWorkspaceFileDrag(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const hit = this.slotHitForDragEvent(event);
    const absolutePath = workspaceFilePathFromDrop(event.dataTransfer);
    this.endFileDrag();
    if (!hit || !absolutePath) {
      return;
    }
    const action = fileDropActionFor(this.layout(), hit.slotId, hit.zone);
    if (action.kind === 'noop') {
      return;
    }
    this.fileDrop.emit({
      absolutePath,
      slotId: hit.slotId,
      side: action.kind === 'split' && action.side ? action.side : null,
    });
  }

  /** Any dragover outside the grid, or the end of the drag, clears the file-drop overlay. */
  @HostListener('document:dragover', ['$event'])
  protected onDocumentDragOver(event: DragEvent): void {
    if (!this.fileDragging()) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) {
      return;
    }
    this.endFileDrag();
  }

  @HostListener('document:dragend')
  @HostListener('document:drop')
  protected onDocumentDragEnd(): void {
    if (this.fileDragging()) {
      this.endFileDrag();
    }
  }

  private endFileDrag(): void {
    this.fileDragging.set(false);
    this.dragPreview.set(null);
  }

  /**
   * Slot + zone under a native drag event. Inside a slot body the edge bands apply; anywhere
   * else in the slot (its tab strip) counts as the center.
   */
  private slotHitForDragEvent(event: DragEvent): { slotId: string; zone: EditorGridDropZone } | null {
    const target = event.target;
    if (!(target instanceof Element)) {
      return null;
    }
    const body = target.closest(`[${SLOT_BODY_ATTR}]`);
    if (body instanceof HTMLElement && this.host.nativeElement.contains(body)) {
      const slotId = body.getAttribute(SLOT_BODY_ATTR);
      if (slotId && slotById(this.layout(), slotId)) {
        return { slotId, zone: hotspotForPoint(body.getBoundingClientRect(), event.clientX, event.clientY) };
      }
    }
    const slotEl = target.closest(`[${SLOT_ATTR}]`);
    if (slotEl instanceof HTMLElement && this.host.nativeElement.contains(slotEl)) {
      const slotId = slotEl.getAttribute(SLOT_ATTR);
      if (slotId && slotById(this.layout(), slotId)) {
        return { slotId, zone: 'center' };
      }
    }
    return null;
  }

  private applyDropAction(source: EditorGridDragSource, action: EditorGridDropAction): void {
    const layout = this.layout();
    switch (action.kind) {
      case 'split': {
        if (!action.side) {
          return;
        }
        const res = splitSlotWithTab(layout, source.slotId, source.tabId, action.targetSlotId, action.side);
        if (res.newSlotId) {
          this.layoutChange.emit(res.layout);
          this.slotFocus.emit(res.newSlotId);
        }
        return;
      }
      case 'move': {
        const next = moveTabToSlot(layout, source.slotId, source.tabId, action.targetSlotId);
        this.layoutChange.emit(next);
        this.slotFocus.emit(action.targetSlotId);
        return;
      }
      case 'noop':
      default:
        return;
    }
  }

  private slotBodyAtPoint(x: number, y: number): { slotId: string; rect: DOMRect } | null {
    const el = document.elementFromPoint(x, y);
    if (!(el instanceof Element)) {
      return null;
    }
    const body = el.closest(`[${SLOT_BODY_ATTR}]`);
    if (!(body instanceof HTMLElement) || !this.host.nativeElement.contains(body)) {
      return null;
    }
    const slotId = body.getAttribute(SLOT_BODY_ATTR);
    if (!slotId || !slotById(this.layout(), slotId)) {
      return null;
    }
    return { slotId, rect: body.getBoundingClientRect() };
  }

  protected bandStyle(preview: EditorGridDragPreview): Record<string, string> {
    const zone = preview.action.kind === 'noop' ? 'center' : preview.zone;
    switch (zone) {
      case 'left':
        return { left: '0', top: '0', bottom: '0', width: 'min(25%, 64px)' };
      case 'right':
        return { right: '0', top: '0', bottom: '0', width: 'min(25%, 64px)' };
      case 'top':
        return { left: '0', right: '0', top: '0', height: 'min(25%, 64px)' };
      case 'bottom':
        return { left: '0', right: '0', bottom: '0', height: 'min(25%, 64px)' };
      default:
        return { inset: '0' };
    }
  }

  // ---------------------------------------------------------------------------
  // Gutter resizing
  // ---------------------------------------------------------------------------

  protected onColumnGutterPointerDown(event: PointerEvent, index: number): void {
    const gridEl = this.host.nativeElement.querySelector('.editor-grid');
    if (!(gridEl instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.gutterDrag = {
      pointerId: event.pointerId,
      kind: 'column',
      columnId: null,
      index,
      startPos: event.clientX,
      startSizes: [...this.layout().columnSizes],
      totalPx: gridEl.getBoundingClientRect().width,
    };
  }

  protected onRowGutterPointerDown(event: PointerEvent, column: EditorGridColumn, index: number): void {
    const colEl = (event.currentTarget as HTMLElement | null)?.closest('.editor-grid__column');
    if (!(colEl instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.gutterDrag = {
      pointerId: event.pointerId,
      kind: 'row',
      columnId: column.id,
      index,
      startPos: event.clientY,
      startSizes: [...column.rowSizes],
      totalPx: colEl.getBoundingClientRect().height,
    };
  }

  @HostListener('document:pointermove', ['$event'])
  protected onDocumentPointerMove(event: PointerEvent): void {
    const drag = this.gutterDrag;
    if (!drag || drag.pointerId !== event.pointerId || drag.totalPx <= 0) {
      return;
    }
    const pos = drag.kind === 'column' ? event.clientX : event.clientY;
    const deltaFraction = (pos - drag.startPos) / drag.totalPx;
    const sizes = adjustSizesAtGutter(drag.startSizes, drag.index, deltaFraction);
    const layout = this.layout();
    this.layoutChange.emit(
      drag.kind === 'column' ? resizeColumns(layout, sizes) : resizeRows(layout, drag.columnId ?? '', sizes),
    );
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  protected onDocumentPointerUp(event: PointerEvent): void {
    if (this.gutterDrag?.pointerId === event.pointerId) {
      this.gutterDrag = null;
    }
  }
}
