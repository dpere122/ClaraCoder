import { Component, computed, effect, input, signal, ViewEncapsulation } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

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
export class ImageViewerComponent {
  readonly workspacePath = input<string>('');
  readonly relativePath = input<string | null>(null);

  /** null = fit to window; a number = explicit zoom factor (1 === actual size). */
  protected readonly zoom = signal<number | null>(null);
  protected readonly loadError = signal(false);
  protected readonly naturalWidth = signal(0);
  protected readonly naturalHeight = signal(0);

  protected readonly fileName = computed(() => {
    const rel = this.relativePath();
    if (!rel) {
      return '';
    }
    const norm = normalizePathSlashes(rel);
    const i = norm.lastIndexOf('/');
    return i >= 0 ? norm.slice(i + 1) : norm;
  });

  protected readonly imageSrc = computed(() => {
    const root = this.workspacePath().trim();
    const rel = this.relativePath();
    if (!root || !rel) {
      return '';
    }
    const norm = normalizePathSlashes(rel).replace(/^\/+/, '');
    if (!norm) {
      return '';
    }
    return `nemo-asset://workspace/?root=${encodeURIComponent(root)}&path=${encodeURIComponent(norm)}`;
  });

  protected readonly isFit = computed(() => this.zoom() === null);
  protected readonly zoomPercent = computed(() => {
    const z = this.zoom();
    return z === null ? null : Math.round(z * 100);
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
  }

  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    this.naturalWidth.set(img.naturalWidth);
    this.naturalHeight.set(img.naturalHeight);
    this.loadError.set(false);
  }

  protected onImageError(): void {
    this.loadError.set(true);
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
}
