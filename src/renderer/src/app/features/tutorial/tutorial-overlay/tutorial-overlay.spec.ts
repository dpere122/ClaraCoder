import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTutorialTransition, type TutorialProgress, type TutorialTransition } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { lucideAppProviders } from '../../../lucide-setup';
import { TutorialCoordinator, type TutorialView } from '../tutorial-coordinator';
import { TUTORIAL_STEPS, type TutorialStepDescriptor } from '../tutorial-steps';
import { TutorialOverlayComponent } from './tutorial-overlay';

let frames: FrameRequestCallback[];
let fixtures: ComponentFixture<TutorialOverlayComponent>[];

function descriptor(id: string): TutorialStepDescriptor {
  return TUTORIAL_STEPS.find((step) => step.stepId === id)!;
}

function rectangle(left: number, top = 100, width = 120, height = 40): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function target(name: string, rect: () => DOMRect): HTMLButtonElement {
  const element = document.createElement('button');
  element.setAttribute('data-tutorial', name);
  element.getBoundingClientRect = rect;
  element.scrollIntoView = vi.fn();
  document.body.appendChild(element);
  return element;
}

function setup(initial: TutorialStepDescriptor) {
  const step = signal<TutorialStepDescriptor | null>(initial);
  const cursor = signal<{ phaseId: string; stepId: string } | null>({ phaseId: initial.phaseId, stepId: initial.stepId });
  const tour = {
    view: signal<TutorialView>('step'),
    descriptor: step,
    cursor,
    snapshot: signal<{ progress: { sourceId?: string } } | null>(null),
    destination: signal(initial.window),
    busy: signal(false),
    minimized: signal(false),
    message: signal(''),
    start: vi.fn(), advance: vi.fn(), skipPhase: vi.fn(), dismissAll: vi.fn(), recoverSource: vi.fn(), noteSourceDraft: vi.fn(), later: vi.fn(),
    handoff: vi.fn(), reopenRequested: vi.fn(), refresh: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [TutorialOverlayComponent],
    providers: [...lucideAppProviders, { provide: TutorialCoordinator, useValue: tour }],
  });
  const fixture = TestBed.createComponent(TutorialOverlayComponent);
  fixtures.push(fixture);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  fixture.detectChanges();
  return { fixture, tour, host: fixture.nativeElement as HTMLElement, step, cursor };
}

async function paint(fixture: ComponentFixture<TutorialOverlayComponent>): Promise<void> {
  await Promise.resolve();
  const pending = frames.splice(0);
  pending.forEach((callback) => callback(1));
  fixture.detectChanges();
  await Promise.resolve();
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === text);
  expect(match, `missing button ${text}`).toBeTruthy();
  return match!;
}

beforeEach(() => {
  frames = [];
  fixtures = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  fixtures.forEach((fixture) => fixture.destroy());
  document.querySelectorAll('[data-tutorial]').forEach((el) => el.remove());
  document.querySelectorAll('[data-test-tutorial-container], app-tutorial-overlay').forEach((el) => el.remove());
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TutorialOverlayComponent', () => {
  it('positions a non-modal highlight, leaves its target interactive, and follows scroll/resize', async () => {
    let left = 100;
    const source = target('home-add-workspace', () => rectangle(left));
    const clicked = vi.fn();
    source.addEventListener('click', clicked);
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const highlight = h.host.querySelector<HTMLElement>('.tutorial-highlight');
    expect(highlight?.style.left).toBe('100px');
    expect(h.host.querySelector('[role="region"]')?.getAttribute('aria-labelledby')).toBe('tutorial-title');
    expect(h.host.querySelector('[aria-live="polite"]')).toBeTruthy();
    source.click();
    expect(clicked).toHaveBeenCalledOnce();
    expect(h.tour.advance).not.toHaveBeenCalled();

    left = 240;
    window.dispatchEvent(new Event('scroll'));
    await paint(h.fixture);
    expect(highlight?.style.left).toBe('240px');
    left = 300;
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(highlight?.style.left).toBe('300px');
  });

  it('announces install errors and keeps continuation explicit while state changes', async () => {
    const deps = target('dependencies-llama', () => rectangle(80));
    deps.setAttribute('data-tutorial-llama-state', 'error');
    deps.setAttribute('data-tutorial-llama-busy', 'false');
    deps.setAttribute('data-tutorial-dependencies-busy', 'false');
    const h = setup(descriptor('engine-install'));
    await paint(h.fixture);
    const live = h.host.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('could not be verified');
    expect(button(h.host, 'Continue without installing')).toBeTruthy();
    expect(h.tour.advance).not.toHaveBeenCalled();
    deps.setAttribute('data-tutorial-llama-state', 'success');
    deps.setAttribute('data-tutorial-dependencies-busy', 'true');
    await Promise.resolve();
    await paint(h.fixture);
    expect(live?.textContent).toContain('other Dependencies work is still active');
    expect(button(h.host, 'Continue to Home')).toBeTruthy();
    expect(h.tour.advance).not.toHaveBeenCalled();
  });

  it('explains when an already-installed engine can return to Home', async () => {
    const deps = target('dependencies-llama', () => rectangle(80));
    deps.setAttribute('data-tutorial-llama-state', 'installed');
    deps.setAttribute('data-tutorial-llama-busy', 'false');
    deps.setAttribute('data-tutorial-dependencies-busy', 'false');
    const h = setup(descriptor('engine-install'));
    await paint(h.fixture);
    expect(h.host.textContent).toContain('close Dependencies and return');
    deps.setAttribute('data-tutorial-dependencies-busy', 'true');
    await Promise.resolve();
    await paint(h.fixture);
    expect(h.host.textContent).toContain('this window stays open');
    expect(h.tour.advance).not.toHaveBeenCalled();
  });

  it('shows the llama.cpp mark and a safe external wiki link in Advanced', async () => {
    target('sources-advanced', () => rectangle(80));
    const h = setup(descriptor('sources-advanced'));
    await paint(h.fixture);
    const mark = h.host.querySelector<HTMLElement>('.tutorial-llama__mark');
    const link = h.host.querySelector<HTMLAnchorElement>('.tutorial-wiki');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.style.getPropertyValue('--tutorial-llama-icon')).toContain('llama-cpp-icon.svg');
    expect(link?.href).toBe('https://github.com/ggml-org/llama.cpp/wiki');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
  });

  it('offers explicit retry, continue and skip when a conditional target disappears', async () => {
    const source = target('featured-low', () => rectangle(80));
    const h = setup(descriptor('featured-low'));
    await paint(h.fixture);
    source.remove();
    await Promise.resolve(); // MutationObserver
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
    expect(h.host.textContent).toContain('hidden or unavailable');
    expect(h.tour.advance).not.toHaveBeenCalled();
    button(h.host, 'Retry target').click();
    expect(h.tour.advance).not.toHaveBeenCalled();
    button(h.host, 'Continue anyway').click();
    button(h.host, 'Skip this phase').click();
    expect(h.tour.advance).toHaveBeenCalledOnce();
    expect(h.tour.skipPhase).toHaveBeenCalledOnce();
  });

  it('reports local-model loading, empty and error states without advancing or choosing a model', async () => {
    const picker = target('sources-local-model', () => rectangle(80));
    picker.setAttribute('data-tutorial-models-state', 'loading');
    const h = setup(descriptor('sources-model'));
    await paint(h.fixture);
    expect(h.host.textContent).toContain('Checking downloaded models');
    picker.setAttribute('data-tutorial-models-state', 'empty');
    await Promise.resolve();
    await paint(h.fixture);
    expect(h.host.textContent).toContain('No downloaded model yet');
    picker.setAttribute('data-tutorial-models-state', 'error');
    await Promise.resolve();
    await paint(h.fixture);
    expect(h.host.textContent).toContain('could not be checked');
    expect(h.tour.advance).not.toHaveBeenCalled();
    expect(button(h.host, 'Retry target')).toBeTruthy();
    expect(button(h.host, 'Skip this phase')).toBeTruthy();
  });

  it('stops observing layout while the guide is hidden', async () => {
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    h.tour.view.set('hidden');
    h.fixture.detectChanges();
    await paint(h.fixture);
    vi.mocked(window.requestAnimationFrame).mockClear();
    target('home-add-workspace', () => rectangle(100));
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(h.host.querySelector('.tutorial-card')).toBeNull();
  });

  it('offers a user-initiated scroll for an offscreen target', async () => {
    const source = target('home-add-workspace', () => rectangle(window.innerWidth + 100));
    source.scrollIntoView = vi.fn();
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    expect(h.host.textContent).toContain('outside the visible area');
    button(h.host, 'Show target').click();
    expect(source.scrollIntoView).toHaveBeenCalledOnce();
    expect(h.tour.advance).not.toHaveBeenCalled();
  });

  it('announces rendered cursor events and retries preview when the Small row mounts late', async () => {
    const events: Array<{ phaseId: string; stepId: string }> = [];
    const listen = (event: Event): void => { events.push((event as CustomEvent).detail); };
    window.addEventListener('clara-tutorial-step', listen);
    const h = setup(descriptor('featured-preview'));
    await paint(h.fixture);
    expect(events).toContainEqual({ phaseId: 'featured-models', stepId: 'featured-preview' });
    const before = events.length;
    target('featured-low', () => rectangle(80));
    await Promise.resolve();
    await paint(h.fixture);
    expect(events.length).toBeGreaterThan(before);
    expect(h.tour.advance).not.toHaveBeenCalled();
    window.removeEventListener('clara-tutorial-step', listen);
  });

  it('warns when a tracked source draft disappears and requires an explicit safe recovery', async () => {
    const nav = target('settings-sources-nav', () => rectangle(30));
    nav.setAttribute('data-tutorial-source-id', 'other-source');
    nav.setAttribute('data-tutorial-source-state', 'persisted');
    target('sources-add', () => rectangle(60));
    const h = setup(descriptor('sources-model'));
    h.tour.snapshot.set({ progress: { sourceId: 'draft-123' } });
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(h.host.textContent).toContain('Source draft unavailable');
    expect(h.host.textContent).toContain('discarded when Settings closed');
    expect(h.host.querySelector('[aria-live="polite"]')?.textContent).toContain('no longer available');
    expect(h.tour.advance).not.toHaveBeenCalled();
    button(h.host, 'Return to Add source').click();
    expect(h.tour.recoverSource).toHaveBeenCalledOnce();
  });

  it('distinguishes an applied but unselected source from a lost draft', async () => {
    const nav = target('settings-sources-nav', () => rectangle(30));
    nav.setAttribute('data-tutorial-source-id', 'other-source');
    nav.setAttribute('data-tutorial-source-state', 'persisted');
    target('sources-add', () => rectangle(60));
    const row = document.createElement('div');
    row.setAttribute('data-tutorial-source-row', 'true');
    row.setAttribute('data-tutorial-source-id', 'saved-123');
    row.getBoundingClientRect = () => rectangle(150);
    document.body.appendChild(row);
    const h = setup(descriptor('sources-model'));
    h.tour.snapshot.set({ progress: { sourceId: 'saved-123' } });
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(h.host.textContent).not.toContain('Source draft unavailable');
    expect(h.host.textContent).toContain('Select the source you created');
    expect(button(h.host, 'Continue without selecting')).toBeTruthy();
    expect(h.tour.recoverSource).not.toHaveBeenCalled();
    row.remove();
  });

  it('offers an explicit continue-without-applying choice for dirty Settings', async () => {
    const nav = target('settings-sources-nav', () => rectangle(30));
    nav.setAttribute('data-tutorial-settings-dirty', 'true');
    target('settings-apply', () => rectangle(80));
    const h = setup(descriptor('sources-apply'));
    await paint(h.fixture);
    expect(button(h.host, 'Continue without applying')).toBeTruthy();
    expect(h.tour.advance).not.toHaveBeenCalled();
    nav.setAttribute('data-tutorial-settings-dirty', 'false');
    await Promise.resolve();
    await paint(h.fixture);
    expect(button(h.host, 'Next')).toBeTruthy();
  });

  it('uses the existing external-link handler and marks the final rendered step complete', async () => {
    const h = setup(descriptor('sources-advanced'));
    await paint(h.fixture);
    const link = h.host.querySelector<HTMLAnchorElement>('.tutorial-wiki');
    expect(link?.href).toBe('https://github.com/ggml-org/llama.cpp/wiki');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');

    expect(h.host.querySelector('.tutorial-complete-icon')).toBeNull();
    expect(h.host.querySelector('.tutorial-mascot')).toBeTruthy();

    const final = descriptor('tour-complete');
    h.step.set(final);
    h.cursor.set({ phaseId: final.phaseId, stepId: final.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(h.host.textContent).toContain("You're ready to explore");
    expect(h.host.querySelector('.tutorial-card lucide-icon.tutorial-complete-icon svg')).toBeTruthy();
    expect(h.host.querySelector('.tutorial-mascot')).toBeNull();
    expect(button(h.host, 'Finish')).toBeTruthy();
  });

  it('lets the final step finish even when the recorded source is gone or unselected', async () => {
    const h = setup(descriptor('tour-complete'));
    h.tour.snapshot.set({ progress: { sourceId: 'lost-source' } });
    target('settings-sources-nav', () => rectangle(0)).setAttribute('data-tutorial-source-id', 'another-source');
    target('sources-add', () => rectangle(200));
    await paint(h.fixture);
    expect(h.host.textContent).not.toContain('Source draft unavailable');
    expect(button(h.host, 'Finish')).toBeTruthy();
    expect(h.host.querySelector('.tutorial-secondary-actions')).toBeNull();
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
  });

  it('does not report a Dependencies install state as a metadata failure', async () => {
    const h = setup(descriptor('engine-intro'));
    target('dependencies-llama', () => rectangle(0)).setAttribute('data-state', 'error');
    await paint(h.fixture);
    expect(h.host.textContent).not.toContain('Details could not be loaded');

    const featured = descriptor('featured-low');
    h.step.set(featured);
    h.cursor.set({ phaseId: featured.phaseId, stepId: featured.stepId });
    target('featured-low', () => rectangle(0)).setAttribute('data-state', 'error');
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(h.host.textContent).toContain('Details could not be loaded');
  });

  it('clips the highlight to nested scrollports, including borders and scrollbars', async () => {
    const outer = document.createElement('div');
    outer.setAttribute('data-test-tutorial-container', '');
    outer.style.overflowX = 'hidden';
    outer.style.overflowY = 'hidden';
    outer.getBoundingClientRect = () => rectangle(20, 50, 220, 160);
    Object.defineProperties(outer, {
      clientLeft: { value: 4 }, clientTop: { value: 5 }, clientWidth: { value: 180 }, clientHeight: { value: 100 },
      offsetWidth: { value: 220 }, offsetHeight: { value: 160 },
    });
    const inner = document.createElement('div');
    inner.style.overflowY = 'auto';
    inner.getBoundingClientRect = () => rectangle(15, 70, 250, 100);
    Object.defineProperties(inner, {
      clientLeft: { value: 0 }, clientTop: { value: 2 }, clientWidth: { value: 250 }, clientHeight: { value: 50 },
      offsetWidth: { value: 250 }, offsetHeight: { value: 100 },
    });
    let top = 80;
    const source = target('home-add-workspace', () => rectangle(0, top, 300, 100));
    source.scrollIntoView = vi.fn();
    inner.appendChild(source);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);

    const outline = h.host.querySelector<HTMLElement>('.tutorial-highlight')!;
    expect([outline.style.left, outline.style.top, outline.style.width, outline.style.height]).toEqual(['24px', '80px', '180px', '42px']);
    expect(getComputedStyle(outline).pointerEvents).toBe('none');
    expect(getComputedStyle(outline).zIndex).toBe('10001');
    expect(getComputedStyle(h.host.querySelector<HTMLElement>('.tutorial-card')!).pointerEvents).toBe('auto');
    top = 200;
    inner.dispatchEvent(new Event('scroll'));
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
    button(h.host, 'Show target').click();
    expect(source.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('selects visible alternatives rather than inert or fully transparent targets', async () => {
    const preferred = target('home-add-workspace', () => rectangle(100));
    const fallback = target('home-file-menu', () => rectangle(340));
    preferred.setAttribute('inert', '');
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    expect(h.host.querySelector<HTMLElement>('.tutorial-highlight')?.style.left).toBe('340px');
    preferred.removeAttribute('inert');
    await Promise.resolve();
    await paint(h.fixture);
    expect(h.host.querySelector<HTMLElement>('.tutorial-highlight')?.style.left).toBe('100px');
    preferred.style.opacity = '0';
    await Promise.resolve();
    await paint(h.fixture);
    expect(h.host.querySelector<HTMLElement>('.tutorial-highlight')?.style.left).toBe('340px');
    expect(fallback.isConnected).toBe(true);
  });

  it('observes target ancestors and stops all resize observation while hidden', async () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    let notify = (): void => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { notify = () => callback([], this as unknown as ResizeObserver); }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    });
    const container = document.createElement('div');
    container.setAttribute('data-test-tutorial-container', '');
    container.appendChild(target('home-add-workspace', () => rectangle(100)));
    document.body.appendChild(container);
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    expect(observe).toHaveBeenCalledWith(container);
    vi.mocked(window.requestAnimationFrame).mockClear();
    notify();
    notify();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    await paint(h.fixture);
    h.tour.view.set('hidden');
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(disconnect).toHaveBeenCalled();
    vi.mocked(window.requestAnimationFrame).mockClear();
    notify();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('fades the whole card on each new step, but not when it only follows scrolling', async () => {
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const card = h.host.querySelector<HTMLElement>('.tutorial-card')!;
    const mark = h.host.querySelector('.tutorial-card__content .tutorial-mascot');
    expect(mark).toBeTruthy();
    const replays = (): boolean => card.classList.contains('tutorial-card--refade');
    const before = replays();

    target('home-add-workspace', () => rectangle(100));
    await Promise.resolve();
    await paint(h.fixture);
    window.dispatchEvent(new Event('scroll'));
    await paint(h.fixture);
    expect(replays()).toBe(before);

    const next = descriptor('home-navigation');
    h.step.set(next);
    h.cursor.set({ phaseId: next.phaseId, stepId: next.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(replays()).toBe(!before);
    // The same card and mark stay mounted, so focus inside the card survives the fade.
    expect(h.host.querySelector('.tutorial-card')).toBe(card);
    expect(h.host.querySelector('.tutorial-mascot')).toBe(mark);
  });

  it('hides the mascot with the rest of the card when minimized', async () => {
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    button(h.host, 'Minimize').click();
    h.fixture.detectChanges();
    expect(h.host.querySelector<HTMLElement>('.tutorial-card__content')?.hidden).toBe(true);
    expect(h.host.querySelector('.tutorial-card__content .tutorial-mascot')).toBeTruthy();
  });

  it('opens Advanced once per step, as soon as it exists, without fighting the user', async () => {
    const h = setup(descriptor('sources-commands'));
    await paint(h.fixture);
    const details = document.createElement('details');
    details.setAttribute('data-tutorial', 'sources-advanced-section');
    document.body.appendChild(details);
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(details.open).toBe(true);

    details.open = false;
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(details.open).toBe(false);

    const next = descriptor('sources-add-command');
    h.step.set(next);
    h.cursor.set({ phaseId: next.phaseId, stepId: next.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(details.open).toBe(true);
    details.remove();
  });

  it('reopens a section the user closed when they ask to retry the target', async () => {
    const details = document.createElement('details');
    details.setAttribute('data-tutorial', 'featured-list');
    document.body.appendChild(details);
    const h = setup(descriptor('featured-low'));
    await paint(h.fixture);
    expect(details.open).toBe(true);
    details.open = false;
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(details.open).toBe(false);
    button(h.host, 'Retry target').click();
    await paint(h.fixture);
    expect(details.open).toBe(true);
    details.remove();
  });

  it('reopens the section of a step after the tour is minimized and restored', async () => {
    const details = document.createElement('details');
    details.setAttribute('data-tutorial', 'sources-advanced-section');
    details.appendChild(target('sources-run-flags', () => rectangle(100)));
    document.body.appendChild(details);
    const h = setup(descriptor('sources-commands'));
    await paint(h.fixture);
    expect(details.open).toBe(true);

    details.open = false;
    h.host.querySelector<HTMLButtonElement>('.tutorial-minimize')!.click();
    h.fixture.detectChanges();
    await paint(h.fixture);
    h.host.querySelector<HTMLButtonElement>('.tutorial-show')!.click();
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(details.open).toBe(true);
    details.remove();
  });

  it('says so when the highlighted target is on the example page', async () => {
    const page = document.createElement('app-tutorial-source-example');
    page.appendChild(target('sources-defaults', () => rectangle(80)));
    document.body.appendChild(page);
    const h = setup(descriptor('sources-defaults'));
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-status')?.textContent).toContain('made-up data');
    page.remove();
  });

  it('does not highlight a target inside a section the user closed, but still highlights the heading', async () => {
    const details = document.createElement('details');
    details.setAttribute('data-tutorial', 'featured-list');
    const summary = document.createElement('summary');
    summary.setAttribute('data-tutorial', 'sources-add');
    summary.getBoundingClientRect = () => rectangle(100);
    details.appendChild(summary);
    details.appendChild(target('featured-low', () => rectangle(100)));
    document.body.appendChild(details);
    const h = setup(descriptor('featured-low'));
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-highlight')).toBeTruthy();

    details.open = false;
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
    expect(h.host.textContent).toContain('hidden or unavailable');

    const add = descriptor('sources-add');
    h.step.set(add);
    h.cursor.set({ phaseId: add.phaseId, stepId: add.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-highlight')).toBeTruthy();
    details.remove();
  });

  it('brings a far-down target into view once per step, then leaves scrolling to the user', async () => {
    const vram = target('sources-vram', () => rectangle(100));
    const h = setup(descriptor('sources-vram'));
    await paint(h.fixture);
    expect(vram.scrollIntoView).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('scroll'));
    await paint(h.fixture);
    expect(vram.scrollIntoView).toHaveBeenCalledOnce();
    expect(h.host.querySelector('.tutorial-highlight')).toBeTruthy();
  });

  it('explains a missing graphics card section instead of skipping it', async () => {
    const h = setup(descriptor('sources-vram'));
    await paint(h.fixture);
    expect(h.tour.advance).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain('detects an NVIDIA graphics card');
  });

  it('keeps the live region mounted and does not steal focus when the guide appears', async () => {
    const outside = target('home-add-workspace', () => rectangle(100));
    outside.focus();
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const live = h.host.querySelector('[aria-live="polite"]');
    expect(document.activeElement).toBe(outside);
    h.tour.view.set('hidden');
    h.fixture.detectChanges();
    expect(h.host.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live?.textContent?.trim()).toBe('');
    h.tour.view.set('invitation');
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(h.host.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live?.textContent).toContain('optional Clara Coder tour');
    expect(document.activeElement).toBe(outside);
  });

  it('restores guide focus when an explicitly activated action replaces its button', async () => {
    // jsdom reports hasFocus() false after removing the active node, even in an active window.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    target('home-add-workspace', () => rectangle(100));
    const h = setup(descriptor('home-workspace'));
    h.tour.view.set('invitation');
    h.fixture.detectChanges();
    await paint(h.fixture);
    h.tour.start.mockImplementation(() => { h.tour.view.set('step'); });
    const start = button(h.host, 'Start tour');
    start.focus();
    start.click();
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(document.activeElement).toBe(h.host.querySelector('#tutorial-title'));
  });

  it('skips the Start step without showing its card when Home is not on screen', async () => {
    const h = setup(descriptor('home-start'));
    await paint(h.fixture);
    expect(h.tour.advance).toHaveBeenCalledOnce();
    expect(h.host.querySelector('.tutorial-card--skipping')).toBeTruthy();
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
  });

  it('shows the Start step and never skips it while Home is on screen', async () => {
    target('home-start', () => rectangle(100));
    const h = setup(descriptor('home-start'));
    await paint(h.fixture);
    expect(h.tour.advance).not.toHaveBeenCalled();
    expect(h.host.querySelector('.tutorial-card--skipping')).toBeNull();
    expect(h.host.querySelector('.tutorial-highlight')).toBeTruthy();
  });

  it('skips the Start step if Home goes away while it is showing', async () => {
    const start = target('home-start', () => rectangle(100));
    const h = setup(descriptor('home-start'));
    await paint(h.fixture);
    expect(h.tour.advance).not.toHaveBeenCalled();
    start.remove();
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(h.tour.advance).toHaveBeenCalledOnce();
    expect(h.host.querySelector('.tutorial-highlight')).toBeNull();
  });

  it('waits for an action in flight, then skips only once and shows the card if that fails', async () => {
    const h = setup(descriptor('home-start'));
    h.tour.busy.set(true);
    await paint(h.fixture);
    expect(h.tour.advance).not.toHaveBeenCalled();
    expect(h.host.querySelector('.tutorial-card--skipping')).toBeTruthy();
    h.tour.busy.set(false);
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(h.tour.advance).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('resize'));
    await paint(h.fixture);
    expect(h.tour.advance).toHaveBeenCalledOnce();
    expect(h.host.querySelector('.tutorial-card--skipping')).toBeNull();
  });

  it('goes from the welcome step straight to the workspace step with the real coordinator', async () => {
    let progress: TutorialProgress = { revision: 1, phases: {}, active: { phaseId: 'intro', stepId: 'welcome' } };
    const snapshot = () => ({ progress, ownerId: 1, requestedWindow: null });
    const titles: (string | undefined)[] = [];
    TestBed.configureTestingModule({
      imports: [TutorialOverlayComponent],
      providers: [{
        provide: ElectronService,
        useValue: {
          isElectron: true,
          getTutorialSnapshot: async () => snapshot(),
          onTutorialUpdated: () => () => {},
          claimTutorial: async () => ({ acquired: true, snapshot: snapshot() }),
          releaseTutorial: async () => snapshot(),
          transitionTutorial: async (request: TutorialTransition) => {
            const result = applyTutorialTransition(progress, request);
            progress = result.progress;
            return { applied: result.applied, snapshot: snapshot() };
          },
        },
      }],
    });
    const tour = TestBed.inject(TutorialCoordinator);
    tour.markHomeRestored();
    tour.enterWindow('home');
    const fixture = TestBed.createComponent(TutorialOverlayComponent);
    fixtures.push(fixture);
    const host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        fixture.detectChanges();
        await paint(fixture);
        const card = host.querySelector('.tutorial-card');
        if (card && !card.classList.contains('tutorial-card--skipping')) titles.push(host.querySelector('h2')?.textContent ?? undefined);
      }
    };
    await settle();
    expect(host.querySelector('h2')?.textContent).toBe('Welcome to Clara Coder');
    button(host, 'Next').click();
    await settle();
    expect(progress.active).toEqual({ phaseId: 'intro', stepId: 'home-workspace' });
    expect(progress.revision).toBe(3);
    expect(host.querySelector('h2')?.textContent).toBe('Your workspace');
    expect(titles).not.toContain('Start here');
  });

  it('keeps technical details collapsed, out of the announcement, and closed again on the next step', async () => {
    target('home-add-workspace', () => rectangle(100));
    target('home-sources', () => rectangle(300));
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const section = h.host.querySelector<HTMLDetailsElement>('.tutorial-details')!;
    expect(section.open).toBe(false);
    expect(section.textContent).toContain('semantic index');
    expect(h.host.querySelector('[aria-live="polite"]')?.textContent).not.toContain('semantic index');
    section.open = true;

    const next = descriptor('home-navigation');
    h.step.set(next);
    h.cursor.set({ phaseId: next.phaseId, stepId: next.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    const nextSection = h.host.querySelector<HTMLDetailsElement>('.tutorial-details')!;
    expect(nextSection.textContent).toContain('cloud API');
    expect(nextSection.open).toBe(false);
  });

  it('shows no details section on a step without any', async () => {
    target('settings-apply', () => rectangle(100));
    const h = setup(descriptor('sources-apply'));
    await paint(h.fixture);
    expect(h.host.querySelector('.tutorial-details')).toBeNull();
  });

  it('does not skip other steps whose targets are absent', async () => {
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    expect(h.tour.advance).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain('This target is not available right now');
  });

  it('preserves focus when a cursor update reuses the same card control', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    target('home-add-workspace', () => rectangle(100));
    target('home-navigation', () => rectangle(300));
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const nextButton = button(h.host, 'Next');
    nextButton.focus();
    const next = descriptor('home-navigation');
    h.step.set(next);
    h.cursor.set({ phaseId: next.phaseId, stepId: next.stepId });
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(document.activeElement).toBe(nextButton);
  });

  it('restores guide focus if an external view update replaces its focused control', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const h = setup(descriptor('home-workspace'));
    h.tour.view.set('invitation');
    h.fixture.detectChanges();
    await paint(h.fixture);
    button(h.host, 'Later').focus();
    h.tour.view.set('handoff');
    h.fixture.detectChanges();
    await paint(h.fixture);
    expect(document.activeElement).toBe(h.host.querySelector('#tutorial-title'));
  });

  it('does not steal focus back if the user leaves the guide during an action', async () => {
    const outside = target('home-add-workspace', () => rectangle(100));
    const h = setup(descriptor('home-workspace'));
    h.tour.view.set('invitation');
    h.fixture.detectChanges();
    await paint(h.fixture);
    let complete = (): void => {};
    h.tour.start.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const start = button(h.host, 'Start tour');
    start.focus();
    start.click();
    outside.focus();
    h.tour.view.set('step');
    h.fixture.detectChanges();
    complete();
    await paint(h.fixture);
    expect(document.activeElement).toBe(outside);
  });

  it('restores the previous app focus when a focused guide action closes it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const outside = target('home-add-workspace', () => rectangle(100));
    outside.focus();
    const h = setup(descriptor('home-workspace'));
    h.tour.view.set('invitation');
    h.fixture.detectChanges();
    await paint(h.fixture);
    h.tour.later.mockImplementation(() => { h.tour.view.set('hidden'); });
    const later = button(h.host, 'Later');
    later.focus();
    later.click();
    h.fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(outside);
  });

  it('preserves keyboard focus when Show target disappears after scrolling', async () => {
    let left = window.innerWidth + 100;
    const source = target('home-add-workspace', () => rectangle(left));
    source.scrollIntoView = vi.fn(() => { left = 100; });
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const show = button(h.host, 'Show target');
    show.focus();
    show.click();
    await paint(h.fixture);
    expect(h.host.textContent).not.toContain('Show target');
    expect(document.activeElement).toBe(h.host.querySelector('#tutorial-title'));
  });

  it('keeps the panel in a short, narrow viewport without covering a small target', async () => {
    vi.stubGlobal('innerWidth', 320);
    vi.stubGlobal('innerHeight', 240);
    target('home-add-workspace', () => rectangle(100, 20, 120, 40));
    const h = setup(descriptor('home-workspace'));
    const panel = h.host.querySelector<HTMLElement>('.tutorial-card')!;
    panel.getBoundingClientRect = () => rectangle(0, 0, 296, 120);
    await paint(h.fixture);
    const x = parseFloat(panel.style.left);
    const y = parseFloat(panel.style.top);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + 296).toBeLessThanOrEqual(320);
    expect(y).toBeGreaterThanOrEqual(60);
    expect(y + 120).toBeLessThanOrEqual(240);
  });

  it('ignores its own animation and scroll events when scheduling layout', async () => {
    const source = target('home-add-workspace', () => rectangle(100));
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    vi.mocked(window.requestAnimationFrame).mockClear();
    h.host.querySelector('.tutorial-mascot')!.dispatchEvent(new Event('animationend', { bubbles: true }));
    h.host.querySelector('.tutorial-card')!.dispatchEvent(new Event('scroll'));
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    source.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it('tracks target geometry only while a relevant transition is running', async () => {
    let left = 100;
    const source = target('home-add-workspace', () => rectangle(left));
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const transition = (type: string, property: string): Event => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: property });
      return event;
    };
    vi.mocked(window.requestAnimationFrame).mockClear();
    source.dispatchEvent(transition('transitionrun', 'opacity'));
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    source.dispatchEvent(transition('transitionrun', 'transform'));
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    left = 180;
    await paint(h.fixture);
    expect(h.host.querySelector<HTMLElement>('.tutorial-highlight')?.style.left).toBe('180px');
    expect(frames.length).toBeGreaterThan(0);
    left = 260;
    source.dispatchEvent(transition('transitionend', 'transform'));
    await paint(h.fixture);
    expect(h.host.querySelector<HTMLElement>('.tutorial-highlight')?.style.left).toBe('260px');
    await paint(h.fixture); // Flush any Angular rendering frame as well as the layout frame.
    expect(frames).toHaveLength(0);
  });

  it('bounds transition tracking if an end event never arrives', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const source = target('home-add-workspace', () => rectangle(100));
    const h = setup(descriptor('home-workspace'));
    await paint(h.fixture);
    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'transform' });
    source.dispatchEvent(event);
    clock.mockReturnValue(3101);
    await paint(h.fixture);
    expect(frames).toHaveLength(0);
  });
});
