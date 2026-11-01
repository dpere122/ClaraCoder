import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { ScreenshotAssetStatus } from '@shared/screenshot-retention';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronService } from '../../../core/electron.service';
import { CaptureImagesDirective } from './capture-images.directive';
import { MarkdownPipe } from './markdown.pipe';

const URL = 'nemo-asset://capture/0123456789abcdef0123456789abcdef.png';
const OTHER_URL = 'nemo-asset://capture/abcdef0123456789abcdef0123456789.png';
const EXPIRED: ScreenshotAssetStatus = { state: 'expired', reason: 'age', retentionDays: 30 };

@Component({
  standalone: true,
  imports: [CaptureImagesDirective, MarkdownPipe],
  template: '<div class="assistant-md" appCaptureImages [innerHTML]="text() | markdown"></div>',
})
class CaptureHost {
  text = signal('');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Mutation observers and IPC promises may each enqueue the next microtask.
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('CaptureImagesDirective', () => {
  let fixture: ComponentFixture<CaptureHost>;
  let host: HTMLElement;
  let changed: (() => void) | undefined;
  let lookup: ReturnType<typeof vi.fn<(url: string) => Promise<ScreenshotAssetStatus>>>;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lookup = vi.fn<(url: string) => Promise<ScreenshotAssetStatus>>()
      .mockResolvedValue({ state: 'available' });
    unsubscribe = vi.fn();
    TestBed.configureTestingModule({
      providers: [{
        provide: ElectronService,
        useValue: {
          getScreenshotAssetStatus: lookup,
          onScreenshotAssetsChanged: (callback: () => void) => {
            changed = callback;
            return unsubscribe;
          },
        },
      }],
    });
    fixture = TestBed.createComponent(CaptureHost);
    fixture.detectChanges();
    host = fixture.nativeElement.querySelector('.assistant-md');
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  function image(url = URL, failed = false): HTMLImageElement {
    const element = document.createElement('img');
    element.setAttribute('src', url);
    element.alt = 'Captured page';
    Object.defineProperties(element, {
      complete: { value: failed, configurable: true },
      naturalWidth: { value: 0, configurable: true },
    });
    host.append(element);
    return element;
  }

  function placeholder(): HTMLElement | null {
    return host.querySelector('.capture-image-placeholder');
  }

  it('handles a 410/tombstone IPC result on a non-bubbling error without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    lookup.mockResolvedValue(EXPIRED);
    const element = image();
    element.dispatchEvent(new Event('error'));
    await settle();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(URL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
    expect(placeholder()?.textContent).toContain('Screenshot expired');
    expect(placeholder()?.textContent).toContain('Removed automatically under the 30-day image retention policy.');
    expect(placeholder()?.getAttribute('role')).toBe('group');
    expect(placeholder()?.getAttribute('aria-live')).toBe('off');
    expect(host.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });

  it.each([
    ['storage', 'Removed to keep screenshot storage within its limit.'],
    ['cleared', 'Removed when screenshot storage was cleared.'],
  ] as const)('explains %s removal without claiming age expiry', async (reason, detail) => {
    lookup.mockResolvedValue({ state: 'expired', reason });
    image();
    await settle();
    expect(placeholder()?.textContent).toContain(detail);
    expect(placeholder()?.textContent).not.toContain('retention policy');
  });

  it('does not invent a retention reason or period for an unknown expiry', async () => {
    lookup.mockResolvedValue({ state: 'expired' });
    image();
    await settle();
    expect(placeholder()?.textContent).toContain('Screenshot expired');
    expect(placeholder()?.textContent).toContain('This screenshot is no longer stored.');
    expect(placeholder()?.textContent).not.toMatch(/retention|day|cleared|limit/);
  });

  it('uses a distinct unavailable message for an unknown missing capture', async () => {
    lookup.mockResolvedValue({ state: 'missing' });
    image();
    await settle();
    expect(placeholder()?.textContent).toContain('Screenshot unavailable');
    expect(placeholder()?.textContent).toContain('could not be found in local storage');
    expect(placeholder()?.textContent).not.toMatch(/expired|retention|automatically/);
  });

  it.each(['available', 'rejected', 'throws'] as const)(
    'does not claim expiry when a failed image has %s status', async (status) => {
      if (status === 'rejected') lookup.mockRejectedValue(new Error('IPC disconnected'));
      if (status === 'throws') lookup.mockImplementation(() => { throw new Error('IPC unavailable'); });
      const element = image();
      element.dispatchEvent(new Event('error'));
      await settle();
      expect(placeholder()?.textContent).toContain('Screenshot unavailable');
      expect(placeholder()?.textContent).toContain('could not be loaded');
      expect(placeholder()?.textContent).not.toMatch(/expired|retention/);
    },
  );

  it('keeps available loading and already loaded captures intact', async () => {
    const loading = image();
    const loaded = image(OTHER_URL);
    Object.defineProperties(loaded, { complete: { value: true }, naturalWidth: { value: 100 } });
    await settle();
    expect(host.querySelectorAll('img').length).toBe(2);
    expect(host.contains(loading)).toBe(true);
    expect(host.contains(loaded)).toBe(true);
    expect(placeholder()).toBeNull();
  });

  it('does not replace a valid image just because its status lookup failed', async () => {
    lookup.mockRejectedValue(new Error('IPC disconnected'));
    const element = image();
    await settle();
    expect(host.contains(element)).toBe(true);
    expect(placeholder()).toBeNull();
  });

  it('discovers mutations and images whose non-bubbling error already happened', async () => {
    image(URL, true);
    await settle();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(URL);
    expect(placeholder()?.textContent).toContain('Screenshot unavailable');
  });

  it('refreshes a successfully loaded capture when storage changes without an img error', async () => {
    const element = image();
    Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: 100 } });
    await settle();
    expect(host.contains(element)).toBe(true);
    changed?.();
    await settle();
    expect(host.contains(element)).toBe(true);
    lookup.mockResolvedValue({ state: 'expired', reason: 'cleared' });
    changed?.();
    await settle();
    expect(host.contains(element)).toBe(false);
    expect(placeholder()?.textContent).toContain('Removed when screenshot storage was cleared.');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('deduplicates status IPC for repeated images and repeated errors in one host', async () => {
    lookup.mockResolvedValue(EXPIRED);
    const first = image();
    const second = image();
    first.dispatchEvent(new Event('error'));
    first.dispatchEvent(new Event('error'));
    second.dispatchEvent(new Event('error'));
    await settle();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(URL);
    expect(host.querySelectorAll('.capture-image-placeholder').length).toBe(2);
    changed?.();
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('preserves hostile alt/title as plain text and removes linked-image fallback navigation', async () => {
    lookup.mockResolvedValue(EXPIRED);
    const element = image();
    const hostile = '<img src="https://evil.test/tracker" onerror="alert(1)"> & <script>x</script>';
    element.alt = hostile;
    element.title = '<a href="https://evil.test">caption</a>';
    const link = document.createElement('a');
    link.href = 'https://evil.test/fallback';
    element.replaceWith(link);
    link.append(element);
    await settle();
    expect(placeholder()?.textContent).toContain(hostile);
    expect(placeholder()?.textContent).toContain(element.title);
    expect(host.querySelector('img, script, a, [onerror]')).toBeNull();
    expect(placeholder()?.innerHTML).toContain('&lt;img');
  });

  it('integrates with sanitized markdown and new innerHTML replacements', async () => {
    lookup.mockResolvedValue(EXPIRED);
    fixture.componentInstance.text.set(`![Original screenshot](${URL})`);
    fixture.detectChanges();
    await settle();
    expect(placeholder()?.textContent).toContain('Original screenshot');
    fixture.componentInstance.text.set(`![Next screenshot](${OTHER_URL})`);
    fixture.detectChanges();
    await settle();
    expect(placeholder()?.textContent).toContain('Next screenshot');
    expect(host.textContent).not.toContain('Original screenshot');
    expect(lookup).toHaveBeenCalledWith(OTHER_URL);
  });

  it('ignores a stale response after replacing DOM even if the new image has the same URL', async () => {
    const stale = deferred<ScreenshotAssetStatus>();
    const fresh = deferred<ScreenshotAssetStatus>();
    lookup.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const oldImage = image();
    await settle();
    oldImage.remove();
    const newImage = image();
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
    stale.resolve(EXPIRED);
    await settle();
    expect(host.contains(newImage)).toBe(true);
    expect(placeholder()).toBeNull();
    fresh.resolve({ state: 'available' });
    await settle();
    expect(host.contains(newImage)).toBe(true);
  });

  it('ignores a stale response after changing an existing img source', async () => {
    const stale = deferred<ScreenshotAssetStatus>();
    lookup.mockReturnValueOnce(stale.promise);
    const element = image();
    await settle();
    element.src = OTHER_URL;
    await settle();
    stale.resolve(EXPIRED);
    await settle();
    expect(host.contains(element)).toBe(true);
    expect(element.src).toBe(OTHER_URL);
    expect(placeholder()).toBeNull();
  });

  it('ignores older status responses after a storage-change refresh', async () => {
    const stale = deferred<ScreenshotAssetStatus>();
    lookup.mockReturnValueOnce(stale.promise);
    const element = image();
    await settle();
    changed?.();
    await settle();
    stale.resolve(EXPIRED);
    await settle();
    expect(host.contains(element)).toBe(true);
    expect(placeholder()).toBeNull();
  });

  it('does not apply pending results to a detached host', async () => {
    const pending = deferred<ScreenshotAssetStatus>();
    lookup.mockReturnValue(pending.promise);
    image();
    await settle();
    host.remove();
    pending.resolve(EXPIRED);
    await settle();
    expect(host.querySelector('img')).not.toBeNull();
    expect(placeholder()).toBeNull();
  });

  it('disconnects observers, listeners and callbacks and ignores pending results on teardown', async () => {
    const pending = deferred<ScreenshotAssetStatus>();
    lookup.mockReturnValue(pending.promise);
    const element = image();
    await settle();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const removeListener = vi.spyOn(host, 'removeEventListener');
    fixture.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function), true);
    changed?.();
    element.dispatchEvent(new Event('error'));
    image(OTHER_URL);
    pending.resolve(EXPIRED);
    await settle();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(placeholder()).toBeNull();
  });

  it('supports browser mocks without storage-change event registration', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElectronService, useValue: { getScreenshotAssetStatus: lookup } }],
    });
    fixture = TestBed.createComponent(CaptureHost);
    fixture.detectChanges();
    host = fixture.nativeElement.querySelector('.assistant-md');
    lookup.mockResolvedValue(EXPIRED);
    image();
    await settle();
    expect(placeholder()?.textContent).toContain('Screenshot expired');
  });

  it.each([
    'https://example.com/tracker.png',
    '//example.com/tracker.png',
    'file:///C:/secret.png',
    'data:image/png;base64,AAAA',
    'nemo-asset://workspace/?path=secret.png',
    'nemo-asset://capture/secret.png',
    'nemo-asset://capture/0123456789ABCDEF0123456789ABCDEF.png',
    `${URL}?remote=true`,
    `${URL}#fragment`,
    `${URL}\n`,
  ])('never queries status or creates placeholders for disallowed source %s', async (source) => {
    const element = image(source, true);
    element.dispatchEvent(new Event('error'));
    await settle();
    changed?.();
    await settle();
    expect(lookup).not.toHaveBeenCalled();
    expect(placeholder()).toBeNull();
    expect(host.contains(element)).toBe(true);
  });
});
