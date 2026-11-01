import { AfterViewInit, Directive, ElementRef, NgZone, OnDestroy, inject } from '@angular/core';
import type { ScreenshotAssetStatus } from '@shared/screenshot-retention';
import { ElectronService } from '../../../core/electron.service';

const CAPTURE_URL = /^nemo-asset:\/\/capture\/[a-f0-9]{32}\.png$/;

type CaptureStatus = ScreenshotAssetStatus | null;

interface CaptureImage {
  image: HTMLImageElement;
  node: HTMLElement;
  url: string;
  failed: boolean;
  revision: number;
}

/** Replaces missing local captures; never fetches, retries, or substitutes another image URL. */
@Directive({
  selector: '[appCaptureImages]',
  standalone: true,
})
export class CaptureImagesDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly electron = inject(ElectronService);
  private readonly zone = inject(NgZone);
  private readonly captures = new Map<HTMLImageElement, CaptureImage>();
  private readonly statuses = new Map<string, Promise<CaptureStatus>>();
  private observer: MutationObserver | null = null;
  private unsubscribe: (() => void) | undefined;
  private destroyed = false;

  // Image errors do not bubble, so a delegated listener must run in the capture phase.
  private readonly onError = (event: Event): void => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !this.host.contains(image)) return;
    this.scan();
    const capture = this.captures.get(image);
    if (!capture || capture.node !== image) return;
    capture.failed = true;
    this.check(capture);
  };

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('error', this.onError, true);
      this.observer = new MutationObserver(() => this.scan());
      this.observer.observe(this.host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      // Older browser/test bridges may omit the optional event registration.
      this.unsubscribe = this.electron.onScreenshotAssetsChanged?.(() => this.refresh());
      this.scan();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.host.removeEventListener('error', this.onError, true);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.captures.clear();
    this.statuses.clear();
  }

  private current(capture: CaptureImage): boolean {
    return !this.destroyed
      && this.host.isConnected
      && this.host.contains(capture.node)
      && this.captures.get(capture.image) === capture
      && (capture.node !== capture.image || capture.image.getAttribute('src') === capture.url);
  }

  private scan(): void {
    if (this.destroyed) return;
    for (const [image, capture] of this.captures) {
      if (!this.current(capture)) this.captures.delete(image);
    }
    // A replacement DOM tree must not inherit a pending response for its old nodes.
    const activeUrls = new Set([...this.captures.values()].map((capture) => capture.url));
    for (const url of this.statuses.keys()) {
      if (!activeUrls.has(url)) this.statuses.delete(url);
    }
    for (const image of this.host.querySelectorAll('img')) {
      const url = image.getAttribute('src') ?? '';
      if (url !== url.trim() || !CAPTURE_URL.test(url) || this.captures.has(image)) continue;
      const capture: CaptureImage = {
        image,
        node: image,
        url,
        failed: image.complete && image.naturalWidth === 0,
        revision: 0,
      };
      this.captures.set(image, capture);
      this.check(capture);
    }
  }

  private refresh(): void {
    if (this.destroyed) return;
    const existing = [...this.captures.values()];
    this.statuses.clear();
    this.scan();
    for (const capture of existing) {
      if (this.current(capture)) this.check(capture);
    }
  }

  private check(capture: CaptureImage): void {
    const revision = ++capture.revision;
    let status = this.statuses.get(capture.url);
    if (!status) {
      // Treat a rejected/missing bridge as a load failure, not proof of expiration.
      status = Promise.resolve()
        .then(() => this.destroyed || this.statuses.get(capture.url) !== status
          ? null : this.electron.getScreenshotAssetStatus(capture.url))
        .catch(() => null);
      this.statuses.set(capture.url, status);
    }
    void status.then((result) => {
      if (capture.revision !== revision || !this.current(capture)) return;
      if (result?.state === 'available' && !capture.failed && capture.node === capture.image) return;
      // A status lookup failure alone must not replace an image that is still loading/loaded.
      if (!result && !capture.failed && capture.node === capture.image) return;
      this.placeholder(capture, result);
    });
  }

  private placeholder(capture: CaptureImage, status: CaptureStatus): void {
    const document = this.host.ownerDocument;
    const expired = status?.state === 'expired';
    const heading = expired ? 'Screenshot expired' : 'Screenshot unavailable';
    let detail = status?.state === 'missing'
      ? 'This screenshot could not be found in local storage.'
      : 'This screenshot could not be loaded.';
    if (expired) {
      switch (status.reason) {
        case 'age':
          detail = Number.isInteger(status.retentionDays) && status.retentionDays! > 0
            ? `Removed automatically under the ${status.retentionDays}-day image retention policy.`
            : 'Removed automatically under the image retention policy.';
          break;
        case 'storage':
          detail = 'Removed to keep screenshot storage within its limit.';
          break;
        case 'cleared':
          detail = 'Removed when screenshot storage was cleared.';
          break;
        default:
          detail = 'This screenshot is no longer stored.';
      }
    }

    // Use spans so replacing an inline image inside a markdown paragraph stays valid HTML.
    const placeholder = document.createElement('span');
    placeholder.className = 'capture-image-placeholder';
    placeholder.setAttribute('role', 'group');
    placeholder.setAttribute('aria-label', heading);
    // The surrounding streaming feed is live; expired images do not need extra announcements.
    placeholder.setAttribute('aria-live', 'off');
    const title = document.createElement('strong');
    title.className = 'capture-image-placeholder__heading';
    title.textContent = heading;
    const description = document.createElement('span');
    description.className = 'capture-image-placeholder__detail';
    description.textContent = detail;
    placeholder.append(title, description);
    const caption = [...new Set([capture.image.alt.trim(), capture.image.title.trim()].filter(Boolean))];
    if (caption.length) {
      const text = document.createElement('span');
      text.className = 'capture-image-placeholder__caption';
      text.textContent = caption.join(' — ');
      placeholder.append(text);
    }
    // A linked markdown image must not leave the placeholder as a remote fallback link.
    const link = capture.node.closest('a');
    capture.node.replaceWith(placeholder);
    capture.node = placeholder;
    if (link && this.host.contains(link)) link.replaceWith(...link.childNodes);
  }
}
