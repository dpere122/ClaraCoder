import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  CdkDrag,
  CdkDragHandle,
  CdkDropList,
  type CdkDragDrop,
  type CdkDragMove,
  type CdkDragStart,
} from '@angular/cdk/drag-drop';
import { LucideAngularModule } from 'lucide-angular';
import {
  applyFileTabStripWheelScroll,
  chatFileTabBasename,
  chatFileTabId,
  chatFileTabModelKey,
  fileTabStripOverlayMetrics,
  fileTabStripScrollLeftFromTrackClick,
  type ChatFileTab,
} from '../app-chat-file-tabs';
import type { EditorGridDragSource } from './editor-grid-drop';

export interface EditorGridTabStripPointer {
  x: number;
  y: number;
  source: EditorGridDragSource;
}

/**
 * Tab strip for one editor-grid slot. Reorders within the strip via CDK drag-drop and
 * participates in the grid-wide `cdkDropListGroup` so tabs can be dragged between slots.
 * Hotspot (split) detection is owned by `app-editor-grid`; this component only reports
 * pointer movement while dragging.
 */
@Component({
  selector: 'app-editor-grid-tab-strip',
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, LucideAngularModule],
  templateUrl: './editor-grid-tab-strip.html',
  styleUrl: './editor-grid-tab-strip.css',
})
export class EditorGridTabStripComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly inj = inject(Injector);

  readonly slotId = input.required<string>();
  readonly tabs = input<readonly ChatFileTab[]>([]);
  readonly activeTabId = input<string | null>(null);
  readonly focused = input(false);
  readonly unsavedKeys = input<ReadonlySet<string>>(new Set());
  readonly detachedKeys = input<ReadonlySet<string>>(new Set());

  readonly tabSelect = output<string>();
  readonly tabClose = output<string>();
  readonly tabContextMenu = output<{ tabId: string; x: number; y: number }>();
  /** Reorder within this strip. */
  readonly reorder = output<{ fromIndex: number; toIndex: number }>();
  /** A tab from another strip was dropped into this one. */
  readonly moveIn = output<{ source: EditorGridDragSource; index: number }>();
  readonly dragStarted = output<EditorGridDragSource>();
  readonly dragMoved = output<EditorGridTabStripPointer>();
  /** Drop released; `overContainer` is false when released over a slot body / outside. */
  readonly dragDropped = output<{ source: EditorGridDragSource; overContainer: boolean }>();
  readonly dragEnded = output<void>();

  protected readonly overlay = signal(fileTabStripOverlayMetrics(0, 0, 0, 0));
  protected readonly overlayDragging = signal(false);
  private readonly tabsRef = viewChild<ElementRef<HTMLElement>>('tabsEl');
  private resizeObserver: ResizeObserver | null = null;
  private thumbDrag: {
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    trackWidth: number;
    thumbSize: number;
  } | null = null;

  /** Drag data for CDK: identifies the source slot + tab. */
  protected readonly dragDataFor = computed(() => {
    const slotId = this.slotId();
    return (tab: ChatFileTab): EditorGridDragSource => ({ slotId, tabId: chatFileTabId(tab) });
  });

  constructor() {
    effect(() => {
      const el = this.tabsRef()?.nativeElement ?? null;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (!el) {
        this.overlay.set(fileTabStripOverlayMetrics(0, 0, 0, 0));
        return;
      }
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.syncOverlay());
        this.resizeObserver.observe(el);
      }
      this.syncOverlay();
    });
    effect(() => {
      this.tabs();
      afterNextRender(() => this.syncOverlay(), { injector: this.inj });
    });
    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
    });
  }

  protected tabId(tab: ChatFileTab): string {
    return chatFileTabId(tab);
  }

  protected modelKey(tab: ChatFileTab): string {
    return chatFileTabModelKey(tab);
  }

  protected basename(tab: ChatFileTab): string {
    return chatFileTabBasename(tab);
  }

  /** Lower-case extension for the file icon tint (`css`, `ts`, …); empty when there is none. */
  protected extension(tab: ChatFileTab): string {
    const name = chatFileTabBasename(tab);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  protected isUnsaved(tab: ChatFileTab): boolean {
    return this.unsavedKeys().has(chatFileTabModelKey(tab));
  }

  protected isDetached(tab: ChatFileTab): boolean {
    return this.detachedKeys().has(chatFileTabModelKey(tab));
  }

  protected title(tab: ChatFileTab): string | null {
    if (tab.outsideWorkspace) {
      return 'This file is outside of the workspace.';
    }
    if (this.isDetached(tab)) {
      return 'This file no longer exists at this path — save to choose a location.';
    }
    return null;
  }

  protected onSelect(tab: ChatFileTab): void {
    this.tabSelect.emit(chatFileTabId(tab));
  }

  protected onClose(event: MouseEvent, tab: ChatFileTab): void {
    event.preventDefault();
    event.stopPropagation();
    this.tabClose.emit(chatFileTabId(tab));
  }

  protected onContextMenu(event: MouseEvent, tab: ChatFileTab): void {
    event.preventDefault();
    event.stopPropagation();
    this.tabContextMenu.emit({ tabId: chatFileTabId(tab), x: event.clientX, y: event.clientY });
  }

  protected onDragStarted(event: CdkDragStart<EditorGridDragSource>): void {
    this.dragStarted.emit(event.source.data);
  }

  protected onDragMoved(event: CdkDragMove<EditorGridDragSource>): void {
    this.dragMoved.emit({ x: event.pointerPosition.x, y: event.pointerPosition.y, source: event.source.data });
  }

  protected onDragEnded(): void {
    this.dragEnded.emit();
  }

  protected onDropped(event: CdkDragDrop<string, string, EditorGridDragSource>): void {
    const source = event.item.data;
    this.dragDropped.emit({ source, overContainer: event.isPointerOverContainer });
    if (!event.isPointerOverContainer) {
      return;
    }
    if (event.previousContainer === event.container) {
      if (event.previousIndex !== event.currentIndex) {
        this.reorder.emit({ fromIndex: event.previousIndex, toIndex: event.currentIndex });
      }
      return;
    }
    this.moveIn.emit({ source, index: event.currentIndex });
  }

  protected onWheel(event: WheelEvent): void {
    const el = event.currentTarget;
    if (el instanceof HTMLElement) {
      applyFileTabStripWheelScroll(el, event);
      this.syncOverlay();
    }
  }

  protected onScroll(): void {
    this.syncOverlay();
  }

  protected onOverlayTrackPointerDown(event: PointerEvent): void {
    const track = event.currentTarget;
    const tabs = this.tabsRef()?.nativeElement;
    if (!(track instanceof HTMLElement) || !tabs) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.classList.contains('chat-area__tab-strip-overlay-thumb')) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const metrics = this.overlay();
    tabs.scrollLeft = fileTabStripScrollLeftFromTrackClick(
      event.clientX - rect.left,
      metrics.thumbSizePx,
      rect.width,
      tabs.scrollWidth,
      tabs.clientWidth,
    );
    this.syncOverlay();
    this.beginThumbDrag(event, track);
  }

  protected onOverlayThumbPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    const track = event.currentTarget instanceof HTMLElement ? event.currentTarget.parentElement : null;
    if (!(track instanceof HTMLElement)) {
      return;
    }
    this.beginThumbDrag(event, track);
  }

  @HostListener('document:pointermove', ['$event'])
  protected onDocumentPointerMove(event: PointerEvent): void {
    const drag = this.thumbDrag;
    const tabs = this.tabsRef()?.nativeElement;
    if (!drag || drag.pointerId !== event.pointerId || !tabs) {
      return;
    }
    const overflow = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const maxOffset = Math.max(0, drag.trackWidth - drag.thumbSize);
    const dx = event.clientX - drag.startX;
    tabs.scrollLeft = drag.startScrollLeft + (maxOffset <= 0 || overflow <= 0 ? 0 : (dx / maxOffset) * overflow);
    this.syncOverlay();
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  protected onDocumentPointerUp(event: PointerEvent): void {
    if (this.thumbDrag?.pointerId === event.pointerId) {
      this.thumbDrag = null;
      this.overlayDragging.set(false);
    }
  }

  private beginThumbDrag(event: PointerEvent, track: HTMLElement): void {
    const tabs = this.tabsRef()?.nativeElement;
    if (!tabs) {
      return;
    }
    event.preventDefault();
    this.thumbDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: tabs.scrollLeft,
      trackWidth: track.getBoundingClientRect().width,
      thumbSize: this.overlay().thumbSizePx,
    };
    this.overlayDragging.set(true);
  }

  private syncOverlay(): void {
    const tabs = this.tabsRef()?.nativeElement;
    if (!tabs) {
      this.overlay.set(fileTabStripOverlayMetrics(0, 0, 0, 0));
      return;
    }
    const track = tabs.parentElement?.querySelector('.chat-area__tab-strip-overlay');
    const trackWidth = track instanceof HTMLElement ? track.clientWidth : tabs.clientWidth;
    this.overlay.set(fileTabStripOverlayMetrics(tabs.scrollLeft, tabs.scrollWidth, tabs.clientWidth, trackWidth));
  }
}
