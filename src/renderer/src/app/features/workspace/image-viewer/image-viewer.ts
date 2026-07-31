import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  NgZone,
  OnDestroy,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule } from 'lucide-angular';
import type { WorkspaceFilesChangedMessage } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import { buildWorkspaceImageAssetUrl } from './image-viewer-asset-url';
import {
  AUTO_PLAY_INTERVAL_OPTIONS_MS,
  galleryIndexForPath,
  galleryNextIndex,
  galleryPreviousIndex,
  parentFolderAbsolutePath,
  parentFolderRelativePath,
  pickGalleryPathAfterRefresh,
  viewableImagesInDirectory,
  workspaceChangeAffectsGalleryFolder,
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
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

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
  private galleryLoadGeneration = 0;
  private autoPlayTimer: ReturnType<typeof setInterval> | null = null;
  private autoPlayTimerGeneration = 0;
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

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onWorkspaceFilesChanged(event));
  }

  ngOnDestroy(): void {
    this.galleryLoadGeneration += 1;
    this.stopAutoPlay();
    window.removeEventListener('keydown', this.keydownHandler);
  }

  protected assetUrlForPath(relativePath: string | null | undefined): string {
    return buildWorkspaceImageAssetUrl(this.workspacePath(), relativePath);
  }

  /** Downscaled static PNG for the gallery strip (avoids decoding full / animated images). */
  protected thumbAssetUrlForPath(relativePath: string | null | undefined): string {
    return buildWorkspaceImageAssetUrl(this.workspacePath(), relativePath, { thumb: true });
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
    if (!this.autoPlayEnabled()) {
      this.stopAutoPlay();
    }
  }

  protected onAutoPlayIntervalChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (Number.isFinite(value) && value > 0) {
      this.autoPlayIntervalMs.set(value);
    }
  }

  private onWorkspaceFilesChanged(event: WorkspaceFilesChangedMessage): void {
    const root = this.workspacePath().trim();
    const rel = this.relativePath()?.trim();
    if (!root || !rel || !this.workspaceRootsEqual(root, event.workspacePath)) {
      return;
    }
    const galleryFolder = parentFolderRelativePath(rel);
    if (!workspaceChangeAffectsGalleryFolder(galleryFolder, event.paths, event.previousPaths)) {
      return;
    }
    void this.loadGalleryForImage(root, rel, { force: true });
  }

  private workspaceRootsEqual(a: string, b: string): boolean {
    const x = normalizePathSlashes(a).replace(/\/+$/, '').toLowerCase();
    const y = normalizePathSlashes(b).replace(/\/+$/, '').toLowerCase();
    return x.length > 0 && x === y;
  }

  private async loadGalleryForImage(
    workspaceRoot: string,
    imageRelativePath: string | null,
    options?: { force?: boolean },
  ): Promise<void> {
    const root = workspaceRoot.trim();
    const rel = imageRelativePath?.trim();
    if (!root || !rel) {
      this.galleryLoadGeneration += 1;
      this.galleryPaths.set([]);
      this.galleryFolderKey = null;
      this.autoPlayEnabled.set(false);
      return;
    }

    const parentRel = parentFolderRelativePath(rel);
    const folderKey = `${root}|${parentRel}`;
    if (!options?.force && folderKey === this.galleryFolderKey) {
      return;
    }

    const previousFolderKey = this.galleryFolderKey;
    const previousIndex = this.currentGalleryIndex();
    this.galleryFolderKey = folderKey;
    if (previousFolderKey !== null && previousFolderKey !== folderKey) {
      this.autoPlayEnabled.set(false);
    }

    const generation = ++this.galleryLoadGeneration;
    this.galleryLoading.set(true);
    try {
      const parentAbs = parentFolderAbsolutePath(root, rel);
      const entries = await this.electron.readDirectory(parentAbs);
      if (generation !== this.galleryLoadGeneration) {
        return;
      }
      const paths = viewableImagesInDirectory(entries, root);
      // Prefer the path currently displayed — user may have navigated siblings during the load.
      const currentRel = this.relativePath()?.trim() ?? rel;
      if (parentFolderRelativePath(currentRel) !== parentRel) {
        return;
      }
      this.galleryPaths.set(paths);

      if (galleryIndexForPath(paths, currentRel) >= 0) {
        return;
      }
      const nextPath = pickGalleryPathAfterRefresh(paths, currentRel, previousIndex);
      if (nextPath) {
        this.navigateToPath(nextPath);
      } else {
        this.autoPlayEnabled.set(false);
      }
    } catch {
      if (generation !== this.galleryLoadGeneration) {
        return;
      }
      this.galleryPaths.set([]);
      this.autoPlayEnabled.set(false);
    } finally {
      if (generation === this.galleryLoadGeneration) {
        this.galleryLoading.set(false);
      }
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
    const generation = this.autoPlayTimerGeneration;
    this.autoPlayTimer = setInterval(() => {
      if (generation !== this.autoPlayTimerGeneration || !this.autoPlayEnabled()) {
        return;
      }
      this.zone.run(() => this.showNext());
    }, this.autoPlayIntervalMs());
  }

  private restartAutoPlayTimer(): void {
    if (!this.autoPlayEnabled()) {
      return;
    }
    this.syncAutoPlayTimer();
  }

  private stopAutoPlay(): void {
    this.autoPlayTimerGeneration += 1;
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
