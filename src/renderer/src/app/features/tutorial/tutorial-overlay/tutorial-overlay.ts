import { Component, effect, ElementRef, inject, NgZone, OnDestroy, signal, untracked } from '@angular/core';
import { TUTORIAL_PHASE_REGISTRY } from '@shared/index';
import { TutorialCoordinator } from '../tutorial-coordinator';
import { TutorialMascotComponent, type TutorialMascotDestination } from '../tutorial-mascot/tutorial-mascot';
import type { TutorialStepDescriptor } from '../tutorial-steps';

type TargetState = 'none' | 'available' | 'offscreen' | 'missing';
type SourceRecovery = 'none' | 'checking' | 'lost' | 'select';
type TourAction = 'start' | 'advance' | 'skipPhase' | 'dismissAll' | 'recoverSource' | 'later' | 'handoff' | 'refresh';
interface Box { left: number; top: number; width: number; height: number }
interface Point { x: number; y: number }
interface TargetMatch { target: HTMLElement | null; state: TargetState; box: Box | null }
interface FocusTicket { element: HTMLElement; settled: boolean }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
}

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
}

/** A non-modal guide: only the card receives pointer events, never the highlight or mascot. */
@Component({
  selector: 'app-tutorial-overlay',
  standalone: true,
  imports: [TutorialMascotComponent],
  templateUrl: './tutorial-overlay.html',
  styleUrl: './tutorial-overlay.css',
})
export class TutorialOverlayComponent implements OnDestroy {
  protected readonly tour = inject(TutorialCoordinator);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly zone = inject(NgZone);
  protected readonly targetState = signal<TargetState>('none');
  protected readonly targetDetail = signal('');
  protected readonly highlight = signal<Box | null>(null);
  protected readonly panelPosition = signal<Point>({ x: 16, y: 16 });
  protected readonly minimized = signal(false);
  protected readonly mascotPosition = signal<TutorialMascotDestination | null>(null);
  protected readonly mascotKey = signal('');
  protected readonly mascotScale = signal(1);
  protected readonly llamaState = signal('');
  protected readonly dependenciesBusy = signal(false);
  protected readonly sourceRecovery = signal<SourceRecovery>('none');
  protected readonly settingsDirty = signal(false);

  private target: HTMLElement | null = null;
  private highlightedTarget: HTMLElement | null = null;
  private readonly observedElements = new Set<Element>();
  private readonly activeTransitions = new Map<Element, Set<string>>();
  private transitionDeadline = 0;
  private previewTarget: Element | null = null;
  private renderedKey = '';
  private presentationKey = '';
  private mascotSerial = 0;
  private resetPanelScroll = false;
  private frame: number | null = null;
  private mutationObserver: MutationObserver | null = null;
  private observingDocument = false;
  private resizeObserver: ResizeObserver | null = null;
  private pendingFocus: FocusTicket | null = null;
  private lastExternalFocus: HTMLElement | null = null;
  private destroyed = false;
  private readonly onLayout = (event: Event): void => {
    // Our own animations and card scrolling cannot move an external target.
    if (event.target instanceof Node && this.host.nativeElement.contains(event.target)) return;
    this.scheduleMeasure();
  };
  private readonly onTransitionRun = (event: TransitionEvent): void => {
    const element = event.target;
    if (!(element instanceof Element) || !this.target || !element.contains(this.target) ||
        !/^(transform|translate|scale|rotate|width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|margin(?:-.+)?|padding(?:-.+)?|flex-basis|grid-template-columns|grid-template-rows)$/.test(event.propertyName)) return;
    const properties = this.activeTransitions.get(element) ?? new Set<string>();
    properties.add(event.propertyName);
    this.activeTransitions.set(element, properties);
    // A missing transitionend must not leave a perpetual animation-frame loop.
    this.transitionDeadline = performance.now() + 3000;
    this.scheduleMeasure();
  };
  private readonly onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target instanceof Element) {
      const properties = this.activeTransitions.get(event.target);
      properties?.delete(event.propertyName);
      if (properties?.size === 0) this.activeTransitions.delete(event.target);
    }
    this.onLayout(event);
  };
  private readonly onFocusIn = (event: FocusEvent): void => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    if (!this.host.nativeElement.contains(element)) {
      if (element !== document.body) {
        this.lastExternalFocus = element;
        this.pendingFocus = null;
      }
    } else if (this.pendingFocus && element !== this.pendingFocus.element) {
      this.pendingFocus = null;
    }
  };
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target)) this.pendingFocus = null;
  };

  constructor() {
    this.zone.runOutsideAngular(() => {
      if (typeof MutationObserver !== 'undefined') {
        this.mutationObserver = new MutationObserver((records) => {
          if (records.some((record) => !this.host.nativeElement.contains(record.target))) this.scheduleMeasure();
        });
      }
      if (typeof ResizeObserver !== 'undefined') this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
    });

    effect(() => {
      const view = this.tour.view();
      const step = view === 'step' ? this.tour.descriptor() : null;
      const key = step ? `${step.phaseId}:${step.stepId}` : '';
      const presentationKey = step ? `step:${key}` : view;
      untracked(() => {
        this.observeDocument(view !== 'hidden');
        if (presentationKey !== this.presentationKey) {
          // A cross-window update can replace the card without a click in this renderer.
          if (this.presentationKey && !this.pendingFocus) this.captureCardFocus(true);
          this.presentationKey = presentationKey;
          this.highlightedTarget = null;
          this.target = null;
          this.activeTransitions.clear();
          this.setTarget('none', null, '');
          this.sourceRecovery.set('none');
          this.mascotPosition.set(null);
          this.mascotKey.set(`${presentationKey}:${++this.mascotSerial}`);
          this.resetPanelScroll = true;
        }
        if (key !== this.renderedKey) {
          this.renderedKey = key;
          this.previewTarget = null;
          if (step) {
            // Let the routed component render before notifying its opt-in preview listener.
            queueMicrotask(() => {
              if (!this.destroyed && this.renderedKey === key && this.tour.view() === 'step') this.emitStep(step);
            });
          }
        }
        if (view === 'hidden') {
          if (this.frame !== null) window.cancelAnimationFrame(this.frame);
          this.frame = null;
          this.target = null;
          this.setTarget('none', null, '');
          this.mascotPosition.set(null);
          this.minimized.set(false);
          this.restoreFocusOnClose();
        } else {
          this.scheduleMeasure();
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.observeDocument(false);
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.pendingFocus = null;
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
  }

  protected toggleMinimized(): void {
    this.captureCardFocus(true);
    this.minimized.update((value) => !value);
    this.resetPanelScroll = true;
    this.scheduleMeasure();
  }

  protected performAction(action: TourAction): void {
    const ticket = this.captureCardFocus(false);
    // Coordinator actions guard their own concurrency and report errors in the card.
    void Promise.resolve(this.tour[action]()).then(
      () => this.settleFocus(ticket),
      () => this.settleFocus(ticket),
    );
  }

  protected retryTarget(): void {
    const step = this.tour.descriptor();
    if (step && this.tour.view() === 'step') this.emitStep(step);
    this.scheduleMeasure();
  }

  protected showTarget(): void {
    this.captureCardFocus(true);
    this.target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    this.scheduleMeasure();
  }

  private captureCardFocus(settled: boolean): FocusTicket | null {
    const element = document.activeElement;
    const panel = this.host.nativeElement.querySelector('.tutorial-card');
    if (!(element instanceof HTMLElement) || !panel?.contains(element)) return null;
    return this.pendingFocus = { element, settled };
  }

  private settleFocus(ticket: FocusTicket | null): void {
    if (!ticket || this.pendingFocus !== ticket || this.destroyed) return;
    ticket.settled = true;
    this.scheduleMeasure();
  }

  private queueFocusRestore(): void {
    const ticket = this.pendingFocus;
    if (!ticket?.settled) return;
    // Wait for Angular to remove a replaced button before deciding whether focus was lost.
    queueMicrotask(() => {
      if (this.destroyed || this.pendingFocus !== ticket) return;
      this.pendingFocus = null;
      const active = document.activeElement;
      if (active === ticket.element && ticket.element.isConnected && !ticket.element.matches(':disabled')) return;
      if ((active !== document.body && active !== ticket.element) || !document.hasFocus()) return;
      const panel = this.host.nativeElement.querySelector<HTMLElement>('.tutorial-card');
      if (panel) panel.scrollTop = 0;
      panel?.querySelector<HTMLElement>(this.minimized() ? '.tutorial-show' : '#tutorial-title')?.focus({ preventScroll: true });
    });
  }

  private restoreFocusOnClose(): void {
    const ticket = this.pendingFocus;
    const previous = this.lastExternalFocus;
    this.pendingFocus = null;
    if (!ticket || !previous) return;
    queueMicrotask(() => {
      if (this.destroyed || this.tour.view() !== 'hidden' || !document.hasFocus()) return;
      const active = document.activeElement;
      if ((active !== document.body && active !== ticket.element) || !previous.isConnected ||
          previous.matches(':disabled') || !this.isDisplayed(previous)) return;
      previous.focus({ preventScroll: true });
    });
  }

  protected phaseLabel(step: TutorialStepDescriptor): string {
    const index = TUTORIAL_PHASE_REGISTRY.findIndex((phase) => phase.id === step.phaseId);
    const phase = TUTORIAL_PHASE_REGISTRY[index];
    const stepIndex = phase?.steps.findIndex((id) => id === step.stepId) ?? -1;
    return index < 0 ? 'Tour' : `Part ${index + 1} of ${TUTORIAL_PHASE_REGISTRY.length} · ${stepIndex + 1} of ${phase.steps.length}`;
  }

  protected destinationLabel(): string {
    const target = this.tour.destination();
    return target === 'dependencies' ? 'Dependencies' : target === 'settings' ? 'Settings' : 'the main window';
  }

  protected nextLabel(step: TutorialStepDescriptor): string {
    if (step.stepId === 'engine-install' && !['success', 'installed'].includes(this.llamaState())) return 'Continue without installing';
    if (this.sourceRecovery() === 'checking') return 'Continue without checking';
    if (this.sourceRecovery() === 'select') return 'Continue without selecting';
    if (step.stepId === 'sources-apply') return this.settingsDirty() ? 'Continue without applying' : 'Next';
    if (step.nextLabel) return step.nextLabel;
    return this.targetState() === 'missing' || this.targetState() === 'offscreen' ? 'Continue anyway' : 'Next';
  }

  protected installStatus(): string {
    const state = this.llamaState();
    if (state === 'checking') return 'Checking llama-server status…';
    if (state === 'installing') return 'An install or its cleanup is in progress. Continuing leaves Dependencies open.';
    if (state === 'error') return 'The install could not be verified. Use Retry in Dependencies, or continue without installing.';
    if (state === 'cancelled') return 'The install was cancelled. You can retry it or continue without installing.';
    if (state === 'installed' && this.dependenciesBusy()) return 'llama-server is already installed, but other Dependencies work is still active. This window will stay open.';
    if (state === 'installed') return 'llama-server is already installed. Continue to close Dependencies and return to the main window.';
    if (state === 'success' && this.dependenciesBusy()) return 'The install was verified, but other Dependencies work is still active. This window will stay open.';
    if (state === 'success') return 'The install was verified. Continue to close Dependencies and return to the main window.';
    if (state === 'missing') return 'llama-server is not installed. Download it if you want a local engine, or continue without it.';
    return '';
  }

  private emitStep(step: TutorialStepDescriptor): void {
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', {
      detail: { phaseId: step.phaseId, stepId: step.stepId },
    }));
  }

  private observeDocument(visible: boolean): void {
    if (this.observingDocument === visible) return;
    this.observingDocument = visible;
    this.zone.runOutsideAngular(() => {
      if (!visible) {
        window.removeEventListener('resize', this.onLayout);
        window.removeEventListener('scroll', this.onLayout, true);
        window.removeEventListener('transitionrun', this.onTransitionRun, true);
        window.removeEventListener('transitionend', this.onTransitionEnd, true);
        window.removeEventListener('transitioncancel', this.onTransitionEnd, true);
        window.removeEventListener('animationend', this.onLayout, true);
        document.removeEventListener('focusin', this.onFocusIn, true);
        document.removeEventListener('pointerdown', this.onPointerDown, true);
        this.mutationObserver?.disconnect();
        this.resizeObserver?.disconnect();
        this.observedElements.clear();
        this.activeTransitions.clear();
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !this.host.nativeElement.contains(active)) {
        this.lastExternalFocus = active;
      }
      window.addEventListener('resize', this.onLayout);
      // Capture also sees scrolling in nested Settings/Dependencies panes.
      window.addEventListener('scroll', this.onLayout, true);
      window.addEventListener('transitionrun', this.onTransitionRun, true);
      window.addEventListener('transitionend', this.onTransitionEnd, true);
      window.addEventListener('transitioncancel', this.onTransitionEnd, true);
      window.addEventListener('animationend', this.onLayout, true);
      document.addEventListener('focusin', this.onFocusIn, true);
      document.addEventListener('pointerdown', this.onPointerDown, true);
      this.mutationObserver?.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'class', 'style', 'hidden', 'inert', 'open', 'aria-hidden', 'aria-busy', 'disabled', 'data-state', 'data-tutorial',
          'data-tutorial-llama-state', 'data-tutorial-llama-busy', 'data-tutorial-dependencies-busy',
          'data-tutorial-llama-visible', 'data-tutorial-models-state', 'data-tutorial-model-selected',
          'data-tutorial-source-id', 'data-tutorial-source-row', 'data-tutorial-source-selected',
          'data-tutorial-source-state', 'data-tutorial-source-kind', 'data-tutorial-settings-dirty',
          'data-tutorial-settings-saving',
        ],
      });
      this.observeElements(null, null);
    });
  }

  private scheduleMeasure(): void {
    if (this.destroyed || this.frame !== null || this.tour.view() === 'hidden') return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      if (this.destroyed) return;
      this.zone.run(() => this.measure());
      if (this.activeTransitions.size) {
        if (performance.now() < this.transitionDeadline) this.scheduleMeasure();
        else this.activeTransitions.clear();
      }
    });
  }

  private measure(): void {
    const view = this.tour.view();
    if (view === 'hidden') {
      this.target = null;
      this.setTarget('none', null, '');
      this.mascotPosition.set(null);
      this.observeElements(null, null);
      return;
    }
    const step = view === 'step' ? this.tour.descriptor() : null;
    // If Model Manager mounted or its filtered Small row appeared after the first event, notify it
    // once more. The component itself preserves intentional selections and never downloads.
    if (step?.stepId === 'featured-preview' && step.phaseId === 'featured-models') {
      const small = document.querySelector('[data-tutorial="featured-small"]');
      if (small && small !== this.previewTarget) {
        this.previewTarget = small;
        this.emitStep(step);
      } else if (!small) {
        this.previewTarget = null;
      }
    }
    if (step?.phaseId === 'local-source' && step.stepId === 'sources-add') {
      const nav = document.querySelector<HTMLElement>('[data-tutorial="settings-sources-nav"]');
      const id = nav?.getAttribute('data-tutorial-source-id');
      if (id && nav?.getAttribute('data-tutorial-source-state') === 'draft' &&
          nav.getAttribute('data-tutorial-source-kind') === 'managed-local') this.tour.noteSourceDraft(id);
    }
    const recovery = this.findSourceRecovery(step);
    if ((this.sourceRecovery() === 'lost') !== (recovery.state === 'lost') && !this.pendingFocus) {
      this.captureCardFocus(true);
    }
    this.sourceRecovery.set(recovery.state);
    const found: TargetMatch = recovery.target
      ? this.targetFromElement(recovery.target)
      : step?.targets?.length ? this.findTarget(step.targets) : { target: null, state: 'none', box: null };
    if (this.target !== found.target) this.activeTransitions.clear();
    this.target = found.target;
    const highlightedTarget = found.state === 'available' ? found.target : null;
    if (highlightedTarget !== this.highlightedTarget) {
      // Re-enter only for a newly available target, not for every scroll/resize frame.
      if (highlightedTarget && this.mascotPosition()) this.mascotKey.set(`${this.presentationKey}:${++this.mascotSerial}`);
      this.highlightedTarget = highlightedTarget;
    }
    const box = found.box;
    const detailState = found.target?.getAttribute('data-state');
    let detail = detailState === 'loading' || detailState === 'idle'
      ? 'Details are loading; you can retry or continue.'
      : detailState === 'error'
        ? 'Details could not be loaded. Retry the app control or continue.'
        : detailState === 'empty' || detailState === 'unavailable'
          ? 'No details are available here. You can retry or continue.'
          : '';
    if (step?.stepId === 'sources-model') {
      const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
      const models = found.target?.getAttribute('data-tutorial-models-state') ?? nav?.getAttribute('data-tutorial-models-state');
      if (models === 'loading' || models === 'unknown') detail = 'Checking downloaded models. Retry or continue while the inventory loads.';
      if (models === 'empty') detail = 'No downloaded GGUF model is available. You can visit Model Manager later or continue without one.';
      if (models === 'error') detail = 'The local model inventory could not be checked. Retry in Settings or continue without a model.';
    }
    if (recovery.state === 'checking') {
      detail = 'Open Sources to check your previous source. Unapplied drafts do not survive closing Settings.';
    } else if (recovery.state === 'select') {
      detail = 'Select the source you created to continue with it, or explicitly continue without selecting it.';
    } else if (recovery.state === 'lost') {
      detail = 'The source you created is no longer available. An unapplied draft may have been discarded when Settings closed.';
    }
    this.setTarget(found.state, box, detail);
    this.settingsDirty.set(document.querySelector('[data-tutorial="settings-sources-nav"]')?.getAttribute('data-tutorial-settings-dirty') === 'true');

    const deps = document.querySelector<HTMLElement>('[data-tutorial-llama-state][data-tutorial-dependencies-busy]');
    this.llamaState.set(deps?.getAttribute('data-tutorial-llama-state') ?? '');
    this.dependenciesBusy.set(deps?.getAttribute('data-tutorial-dependencies-busy') !== 'false');

    const panel = this.host.nativeElement.querySelector<HTMLElement>('.tutorial-card');
    if (!panel) {
      this.scheduleMeasure();
      return;
    }
    if (this.resetPanelScroll) {
      panel.scrollTop = 0;
      this.resetPanelScroll = false;
    }
    this.observeElements(found.target, panel);
    const panelRect = panel.getBoundingClientRect();
    const width = Math.min(panelRect.width || 360, Math.max(0, window.innerWidth - 24));
    const height = Math.min(panelRect.height || 280, Math.max(0, window.innerHeight - 24));
    const position = this.placePanel(box, width, height);
    if (position.x !== this.panelPosition().x || position.y !== this.panelPosition().y) this.panelPosition.set(position);
    const scale = window.innerWidth < 360 || window.innerHeight < 320 ? 0.58 :
      window.innerWidth < 600 || window.innerHeight < 480 ? 0.7 : 1;
    if (scale !== this.mascotScale()) this.mascotScale.set(scale);
    const mascot = this.placeMascot({ left: position.x, top: position.y, width, height }, box, scale, !!step?.celebration);
    const currentMascot = this.mascotPosition();
    if (!currentMascot || currentMascot.x !== mascot.x || currentMascot.y !== mascot.y) this.mascotPosition.set(mascot);
    this.queueFocusRestore();
  }

  private setTarget(state: TargetState, box: Box | null, detail: string): void {
    if (this.targetState() !== state) this.targetState.set(state);
    if (!sameBox(this.highlight(), box)) this.highlight.set(box);
    if (this.targetDetail() !== detail) this.targetDetail.set(detail);
  }

  private observeElements(target: Element | null, panel: Element | null): void {
    if (!this.resizeObserver || !this.observingDocument) return;
    const next = new Set<Element>([document.documentElement, document.body]);
    if (panel) next.add(panel);
    for (let node = target; node && node !== document.body; node = node.parentElement) next.add(node);
    // Ancestor resizes can change clipping without changing the target's own dimensions.
    for (const element of this.observedElements) {
      if (!next.has(element)) {
        this.resizeObserver.unobserve(element);
        this.observedElements.delete(element);
      }
    }
    for (const element of next) {
      if (!this.observedElements.has(element)) {
        this.resizeObserver.observe(element);
        this.observedElements.add(element);
      }
    }
  }

  private findSourceRecovery(step: TutorialStepDescriptor | null): { state: SourceRecovery; target: HTMLElement | null } {
    const id = this.tour.snapshot()?.progress.sourceId;
    if (!id || !step || step.phaseId !== 'local-source' || ['sources-navigation', 'sources-add'].includes(step.stepId)) {
      return { state: 'none', target: null };
    }
    const nav = document.querySelector<HTMLElement>('[data-tutorial="settings-sources-nav"]');
    if (!nav || nav.getAttribute('data-tutorial-source-state') === 'loading') return { state: 'checking', target: nav };
    if (nav.getAttribute('data-tutorial-source-id') === id) return { state: 'none', target: null };
    const add = document.querySelector<HTMLElement>('[data-tutorial="sources-add"]');
    if (!add) return { state: 'checking', target: nav };
    const row = [...document.querySelectorAll<HTMLElement>('[data-tutorial-source-row]')]
      .find((item) => item.getAttribute('data-tutorial-source-id') === id);
    if (!row) return { state: 'lost', target: add };
    return { state: 'select', target: row.querySelector<HTMLElement>('.source-row') ?? row };
  }

  private targetFromElement(target: HTMLElement): TargetMatch {
    if (!this.isDisplayed(target)) return { target: null, state: 'missing', box: null };
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { target: null, state: 'missing', box: null };
    const box = this.visibleBox(target, rect);
    return { target, state: box ? 'available' : 'offscreen', box };
  }

  private findTarget(names: readonly string[]): TargetMatch {
    let offscreen: TargetMatch | null = null;
    for (const name of names) {
      // Descriptor names are constants; no untrusted selector text enters this query.
      for (const target of document.querySelectorAll<HTMLElement>(`[data-tutorial="${name}"]`)) {
        if (this.host.nativeElement.contains(target)) continue;
        const match = this.targetFromElement(target);
        if (match.state === 'available') return match;
        if (match.state === 'offscreen') offscreen ??= match;
      }
    }
    return offscreen ?? { target: null, state: 'missing', box: null };
  }

  private isDisplayed(target: HTMLElement): boolean {
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.opacity === '0' || style.getPropertyValue('content-visibility') === 'hidden') return false;
    }
    return true;
  }

  /** Clip to the viewport and each scroll container's padding box, not its border or scrollbar. */
  private visibleBox(target: HTMLElement, rect: DOMRect): Box | null {
    let left = Math.max(0, rect.left);
    let right = Math.min(window.innerWidth, rect.right);
    let top = Math.max(0, rect.top);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    for (let node = target.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
      const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
      if (clipX || clipY) {
        const parent = node.getBoundingClientRect();
        // Client metrics are untransformed; scale them with a transformed ancestor's bounding box.
        const scaleX = node.offsetWidth ? parent.width / node.offsetWidth : 1;
        const scaleY = node.offsetHeight ? parent.height / node.offsetHeight : 1;
        const clientLeft = parent.left + node.clientLeft * scaleX;
        const clientTop = parent.top + node.clientTop * scaleY;
        if (clipX) { left = Math.max(left, clientLeft); right = Math.min(right, clientLeft + node.clientWidth * scaleX); }
        if (clipY) { top = Math.max(top, clientTop); bottom = Math.min(bottom, clientTop + node.clientHeight * scaleY); }
      }
    }
    if (right <= left || bottom <= top) return null;
    const x = Math.round(left);
    const y = Math.round(top);
    return { left: x, top: y, width: Math.max(1, Math.round(right) - x), height: Math.max(1, Math.round(bottom) - y) };
  }

  private placePanel(box: Box | null, width: number, height: number): Point {
    const maxX = window.innerWidth - width - 12;
    const maxY = window.innerHeight - height - 12;
    if (!box) return { x: clamp(window.innerWidth - width - 24, 12, maxX), y: clamp(72, 12, maxY) };
    const candidates = [
      { x: box.left + box.width + 16, y: box.top },
      { x: box.left - width - 16, y: box.top },
      { x: box.left, y: box.top + box.height + 16 },
      { x: box.left, y: box.top - height - 16 },
    ].map(({ x, y }) => ({ x: clamp(x, 12, maxX), y: clamp(y, 12, maxY) }));
    const overlap = (point: Point): number => overlapArea({ left: point.x, top: point.y, width, height }, box);
    return candidates.reduce((best, candidate) => overlap(candidate) < overlap(best) ? candidate : best);
  }

  private placeMascot(panel: Box, target: Box | null, scale: number, celebrating: boolean): Point {
    const width = 104 * scale;
    const height = 120 * scale;
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const centerX = panel.left + panel.width / 2;
    const centerY = panel.top + Math.min(panel.height / 2, halfHeight);
    // Leave space for the final burst so the card does not hide half of the fireworks.
    const gap = celebrating ? 88 * scale : 8;
    const candidates = [
      { x: panel.left - halfWidth - gap, y: centerY },
      { x: panel.left + panel.width + halfWidth + gap, y: centerY },
      { x: centerX, y: panel.top - halfHeight - gap },
      { x: centerX, y: panel.top + panel.height + halfHeight + gap },
      { x: window.innerWidth - halfWidth, y: halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: window.innerWidth - halfWidth, y: window.innerHeight - halfHeight },
      { x: halfWidth, y: window.innerHeight - halfHeight },
    ].map(({ x, y }) => ({
      x: width > window.innerWidth ? window.innerWidth / 2 : clamp(x, halfWidth, window.innerWidth - halfWidth),
      y: height > window.innerHeight ? window.innerHeight / 2 : clamp(y, halfHeight, window.innerHeight - halfHeight),
    }));
    const score = (point: Point): number => {
      const bounds = { left: point.x - halfWidth, top: point.y - halfHeight, width, height };
      return overlapArea(bounds, panel) * 4 + (target ? overlapArea(bounds, target) * 2 : 0);
    };
    return candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best);
  }
}
