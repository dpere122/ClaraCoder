import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  AUTO_PLAY_INTERVAL_OPTIONS_MS,
  galleryIndexForPath,
  galleryNextIndex,
  galleryPreviousIndex,
  parentFolderAbsolutePath,
  parentFolderRelativePath,
  viewableImagesInDirectory,
} from './image-viewer-gallery';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

@Component({
  selector: 'app-image-viewer',
  imports: [LucideAngularModule],
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.css',
  encapsulation: ViewEncapsulation.None,
})
export class ImageViewerComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly workspacePath = input<string>('');
  readonly relativePath = input<string | null>(null);
  /** True when the image tab panel is visible and should receive keyboard shortcuts. */
  readonly active = input(false);

  readonly navigateTo = output<{ relativePath: string }>();

  protected readonly autoPlayIntervalOptions = AUTO_PLAY_INTERVAL_OPTIONS_MS;

  /** null = fit to window; a number = explicit zoom factor (1 === actual size). */
  protected readonly zoom = signal<number | null>(null);
  protected readonly loadError = signal(false);
  protected readonly naturalWidth = signal(0);
  protected readonly naturalHeight = signal(0);
  protected readonly galleryPaths = signal<string[]>([]);
  protected readonly galleryLoading = signal(false);
  protected readonly autoPlayEnabled = signal(false);
  protected readonly autoPlayIntervalMs = signal(3000);

  private galleryFolderKey: string | null = null;
  private autoPlayTimer: ReturnType<typeof setInterval> | null = null;
  private readonly keydownHandler = (event: KeyboardEvent) => this.onWindowKeydown(event);

  protected readonly fileName = computed(() => {
    const rel = this.relativePath();
    if (!rel) {
      return '';
    }
    const norm = normalizePathSlashes(rel);
    const i = norm.lastIndexOf('/');
    return i >= 0 ? norm.slice(i + 1) : norm;
  });

  protected readonly imageSrc = computed(() => this.assetUrlForPath(this.relativePath()));

  protected readonly isFit = computed(() => this.zoom() === null);
  protected readonly zoomPercent = computed(() => {
    const z = this.zoom();
    return z === null ? null : Math.round(z * 100);
  });

  protected readonly hasGallery = computed(() => this.galleryPaths().length > 1);

  protected readonly currentGalleryIndex = computed(() => {
    const rel = this.relativePath();
    if (!rel) {
      return -1;
    }
    return galleryIndexForPath(this.galleryPaths(), rel);
  });

  protected readonly galleryCounterLabel = computed(() => {
    const total = this.galleryPaths().length;
    const index = this.currentGalleryIndex();
    if (total <= 1 || index < 0) {
      return '';
    }
    return `${index + 1} / ${total}`;
  });

  constructor() {
    effect(() => {
      // Reset view state whenever the displayed file changes.
      this.relativePath();
      this.zoom.set(null);
      this.loadError.set(false);
      this.naturalWidth.set(0);
      this.naturalHeight.set(0);
    });

    effect(() => {
      const root = this.workspacePath().trim();
      const rel = this.relativePath();
      void this.loadGalleryForImage(root, rel);
    });

    effect(() => {
      this.active();
      this.syncKeyboardListener();
    });

    effect(() => {
      this.autoPlayEnabled();
      this.autoPlayIntervalMs();
      this.relativePath();
      this.loadError();
      this.hasGallery();
      this.syncAutoPlayTimer();
    });

    effect(() => {
      const index = this.currentGalleryIndex();
      if (index >= 0) {
        queueMicrotask(() => this.scrollActiveThumbnailIntoView());
      }
    });
  }

  ngOnDestroy(): void {
    this.stopAutoPlay();
    window.removeEventListener('keydown', this.keydownHandler);
  }

  protected assetUrlForPath(relativePath: string | null | undefined): string {
    const root = this.workspacePath().trim();
    const rel = relativePath;
    if (!root || !rel) {
      return '';
    }
    const norm = normalizePathSlashes(rel).replace(/^\/+/, '');
    if (!norm) {
      return '';
    }
    return `nemo-asset://workspace/?root=${encodeURIComponent(root)}&path=${encodeURIComponent(norm)}`;
  }

  protected isActiveGalleryPath(path: string): boolean {
    const rel = this.relativePath();
    return !!rel && normalizePathSlashes(rel) === normalizePathSlashes(path);
  }

  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    this.naturalWidth.set(img.naturalWidth);
    this.naturalHeight.set(img.naturalHeight);
    this.loadError.set(false);
  }

  protected onImageError(): void {
    this.loadError.set(true);
    this.autoPlayEnabled.set(false);
  }

  protected fitToWindow(): void {
    this.zoom.set(null);
  }

  protected actualSize(): void {
    this.zoom.set(1);
  }

  protected zoomIn(): void {
    const current = this.zoom() ?? 1;
    this.zoom.set(Math.min(MAX_ZOOM, current * ZOOM_STEP));
  }

  protected zoomOut(): void {
    const current = this.zoom() ?? 1;
    this.zoom.set(Math.max(MIN_ZOOM, current / ZOOM_STEP));
  }

  protected showPrevious(): void {
    this.navigateGalleryByOffset(-1);
  }

  protected showNext(): void {
    this.navigateGalleryByOffset(1);
  }

  protected onThumbnailClick(path: string): void {
    this.navigateToPath(path);
  }

  protected toggleAutoPlay(): void {
    if (!this.hasGallery()) {
      return;
    }
    this.autoPlayEnabled.update((enabled) => !enabled);
  }

  protected onAutoPlayIntervalChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (Number.isFinite(value) && value > 0) {
      this.autoPlayIntervalMs.set(value);
    }
  }

  private async loadGalleryForImage(workspaceRoot: string, imageRelativePath: string | null): Promise<void> {
    const root = workspaceRoot.trim();
    const rel = imageRelativePath?.trim();
    if (!root || !rel) {
      this.galleryPaths.set([]);
      this.galleryFolderKey = null;
      this.autoPlayEnabled.set(false);
      return;
    }

    const parentRel = parentFolderRelativePath(rel);
    const folderKey = `${root}|${parentRel}`;
    if (folderKey === this.galleryFolderKey) {
      return;
    }

    const previousFolderKey = this.galleryFolderKey;
    this.galleryFolderKey = folderKey;
    if (previousFolderKey !== null && previousFolderKey !== folderKey) {
      this.autoPlayEnabled.set(false);
    }

    this.galleryLoading.set(true);
    try {
      const parentAbs = parentFolderAbsolutePath(root, rel);
      const entries = await this.electron.readDirectory(parentAbs);
      this.galleryPaths.set(viewableImagesInDirectory(entries, root));
    } catch {
      this.galleryPaths.set([]);
    } finally {
      this.galleryLoading.set(false);
    }
  }

  private navigateGalleryByOffset(offset: -1 | 1): void {
    const paths = this.galleryPaths();
    const currentIndex = this.currentGalleryIndex();
    if (paths.length <= 1 || currentIndex < 0) {
      return;
    }
    const nextIndex =
      offset < 0
        ? galleryPreviousIndex(currentIndex, paths.length)
        : galleryNextIndex(currentIndex, paths.length);
    const nextPath = paths[nextIndex];
    if (nextPath) {
      this.navigateToPath(nextPath);
    }
  }

  private navigateToPath(path: string): void {
    const rel = this.relativePath();
    if (!rel || normalizePathSlashes(rel) === normalizePathSlashes(path)) {
      return;
    }
    this.navigateTo.emit({ relativePath: normalizePathSlashes(path) });
    this.restartAutoPlayTimer();
  }

  private syncKeyboardListener(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    if (this.active()) {
      window.addEventListener('keydown', this.keydownHandler);
    }
  }

  private onWindowKeydown(event: KeyboardEvent): void {
    if (!this.active() || !this.hasGallery()) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.showPrevious();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.showNext();
    }
  }

  private syncAutoPlayTimer(): void {
    this.stopAutoPlay();
    if (
      !this.autoPlayEnabled() ||
      !this.hasGallery() ||
      this.loadError() ||
      !this.relativePath()
    ) {
      return;
    }
    this.autoPlayTimer = setInterval(() => {
      this.showNext();
    }, this.autoPlayIntervalMs());
  }

  private restartAutoPlayTimer(): void {
    if (!this.autoPlayEnabled()) {
      return;
    }
    this.syncAutoPlayTimer();
  }

  private stopAutoPlay(): void {
    if (this.autoPlayTimer !== null) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
  }

  private scrollActiveThumbnailIntoView(): void {
    const host = this.host.nativeElement;
    const active = host.querySelector('.image-viewer-thumb--active') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}
