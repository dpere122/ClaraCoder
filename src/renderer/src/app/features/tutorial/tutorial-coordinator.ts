import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  isTutorialPhaseResolved,
  isTutorialProgressSupported,
  TUTORIAL_PHASE_REGISTRY,
  type TutorialCursor,
  type TutorialSnapshot,
  type TutorialTransition,
  type TutorialWindow,
} from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { tutorialStepFor } from './tutorial-steps';

export type TutorialView = 'hidden' | 'invitation' | 'step' | 'handoff' | 'recovery' | 'unsupported' | 'issue';

type TutorialAction = TutorialTransition['action'];

/** One instance per renderer. Main owns the lease and the durable, revision-checked cursor. */
@Injectable({ providedIn: 'root' })
export class TutorialCoordinator {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly leaseId = signal<number | null>(null);
  private readonly homeRestored = signal(false);
  private readonly paused = signal(false);
  private offUpdated: (() => void) | null = null;
  private epoch = 0;
  private broadcasts = 0;
  private attemptedClaim = '';
  private observedSourceId: string | null = null;
  private destroyed = false;

  readonly role = signal<TutorialWindow | null>(null);
  readonly snapshot = signal<TutorialSnapshot | null>(null);
  readonly busy = signal(false);
  readonly message = signal('');
  /** The card is tucked away so the user can work in the real window. */
  readonly minimized = signal(false);
  readonly ownsLease = computed(() => {
    const id = this.leaseId();
    return id !== null && this.snapshot()?.ownerId === id;
  });
  readonly cursor = computed(() => this.snapshot()?.progress.active ?? null);
  readonly descriptor = computed(() => tutorialStepFor(this.cursor()));
  readonly destination = computed(() => this.descriptor()?.window ?? this.snapshot()?.requestedWindow ?? null);
  readonly hasUnresolved = computed(() => {
    const progress = this.snapshot()?.progress;
    return !!progress && TUTORIAL_PHASE_REGISTRY.some((phase) => !isTutorialPhaseResolved(progress.phases[phase.id]));
  });

  readonly view = computed<TutorialView>(() => {
    const role = this.role();
    const snapshot = this.snapshot();
    if (!role || !this.electron.isElectron || this.paused() || (role === 'home' && !this.homeRestored())) return 'hidden';
    if (this.ownsLease()) {
      if (snapshot && !isTutorialProgressSupported(snapshot.progress)) return 'unsupported';
      const active = snapshot?.progress.active;
      if (!active) return role === 'home' && this.hasUnresolved() ? 'invitation' : 'hidden';
      // An opaque record for this phase may carry semantics from a newer release.
      if (isTutorialPhaseResolved(snapshot.progress.phases[active.phaseId])) return 'unsupported';
      const step = this.descriptor();
      if (!step) return 'unsupported';
      return step.window === role ? 'step' : 'handoff';
    }
    // During a reserved handoff Home can reopen the requested window, but cannot mutate the tour.
    if (role === 'home' && snapshot?.ownerId === null && snapshot.progress.active && snapshot.requestedWindow && snapshot.requestedWindow !== 'home') {
      return 'recovery';
    }
    if (this.message() && (!snapshot || snapshot.ownerId === null)) return 'issue';
    return 'hidden';
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.epoch++;
      this.offUpdated?.();
      this.offUpdated = null;
      // Window destruction also releases in main; neither path dismisses progress or closes a window.
      if (this.ownsLease()) void this.electron.releaseTutorial().catch(() => {});
    });
  }

  /** Called from the shared shell after routing, including null for unsupported windows. */
  enterWindow(role: TutorialWindow | null): void {
    if (this.role() === role) return;
    const owned = this.ownsLease();
    this.epoch++;
    // The previous route's pending IPC will not clear busy in its stale-epoch finally block.
    this.busy.set(false);
    this.offUpdated?.();
    this.offUpdated = null;
    this.leaseId.set(null);
    this.snapshot.set(null);
    this.message.set('');
    this.attemptedClaim = '';
    this.role.set(role);
    if (owned) void this.electron.releaseTutorial().catch(() => {});
    if (!role || !this.electron.isElectron || this.destroyed) return;
    const epoch = this.epoch;
    this.offUpdated = this.electron.onTutorialUpdated((snapshot) => {
      if (this.epoch !== epoch || this.destroyed) return;
      this.broadcasts++;
      this.acceptSnapshot(snapshot);
    });
    void this.refresh();
  }

  /** The home component calls this only after config, tabs, and conversations are restored. */
  markHomeRestored(): void {
    this.homeRestored.set(true);
    this.maybeClaim();
  }

  markHomeUnrestored(): void {
    this.homeRestored.set(false);
  }

  async refresh(): Promise<void> {
    if (!this.role() || !this.electron.isElectron || this.destroyed) return;
    const epoch = this.epoch;
    const broadcasts = this.broadcasts;
    try {
      const snapshot = await this.electron.getTutorialSnapshot();
      if (this.epoch !== epoch || this.destroyed) return;
      this.attemptedClaim = '';
      this.acceptResponse(snapshot, broadcasts);
      this.message.set('');
      this.maybeClaim();
    } catch {
      if (this.epoch === epoch && !this.destroyed) this.message.set('Could not check the tour. Retry when the app is ready.');
    }
  }

  async start(): Promise<void> {
    await this.transition('start');
  }

  async advance(): Promise<void> {
    await this.transition('advance');
  }

  async skipPhase(): Promise<void> {
    await this.transition('skip-phase');
  }

  async dismissAll(): Promise<void> {
    await this.transition('dismiss-all');
  }

  /** Record only an observed ID, not ephemeral source settings or model values. */
  noteSourceDraft(id: string): void {
    const cursor = this.cursor();
    if (cursor?.phaseId === 'local-source' && cursor.stepId === 'sources-add' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      this.observedSourceId = id;
    }
  }

  /** A user-requested rewind after an ephemeral Settings source draft disappeared. */
  async recoverSource(): Promise<void> {
    this.observedSourceId = null;
    await this.transition('recover-source');
  }

  /** Snooze only in this renderer session; a later launch can offer the same progress again. */
  async later(): Promise<void> {
    if (!this.ownsLease() || this.busy()) return;
    this.paused.set(true);
    this.busy.set(true);
    const epoch = this.epoch;
    try {
      const broadcasts = this.broadcasts;
      const snapshot = await this.electron.releaseTutorial();
      if (this.epoch === epoch && !this.destroyed) {
        this.leaseId.set(null);
        this.acceptResponse(snapshot, broadcasts);
      }
    } catch {
      if (this.epoch === epoch && !this.destroyed) {
        this.paused.set(false);
        this.message.set('Could not pause the tour. Please retry.');
      }
    } finally {
      if (this.epoch === epoch && !this.destroyed) this.busy.set(false);
    }
  }

  /** Resume an orphaned cursor without advancing it or altering any Settings draft. */
  async handoff(): Promise<void> {
    const step = this.descriptor();
    if (!this.ownsLease() || this.busy() || !step || step.window === this.role()) return;
    this.busy.set(true);
    const epoch = this.epoch;
    try {
      await this.releaseTo(step.window, this.cursor(), epoch);
    } catch {
      if (this.epoch === epoch && !this.destroyed) this.message.set('Could not move the tour to that window. Retry.');
    } finally {
      if (this.epoch === epoch && !this.destroyed) {
        this.busy.set(false);
        this.maybeClaim();
      }
    }
  }

  /** A reserved window may have failed to open. This does not claim or mutate the lease. */
  reopenRequested(): void {
    const snapshot = this.snapshot();
    if (this.role() !== 'home' || snapshot?.ownerId !== null || !snapshot.requestedWindow || this.busy()) return;
    this.openDestination(snapshot.requestedWindow, snapshot.progress.active);
  }

  /** The existing Home actions remain usable; clicking one is also an explicit handoff. */
  handleHomeNavigation(target: 'dependencies' | 'modelManager'): boolean {
    const cursor = this.cursor();
    const matches = target === 'dependencies'
      ? cursor?.phaseId === 'intro' && cursor.stepId === 'home-dependencies'
      : cursor?.phaseId === 'featured-models' && cursor.stepId === 'home-model-manager';
    if (this.role() !== 'home' || !this.ownsLease() || !matches) return false;
    if (!this.busy()) void this.advance();
    return true;
  }

  private acceptResponse(snapshot: TutorialSnapshot, broadcastsAtRequest: number): void {
    // An IPC response can arrive after a newer ownership broadcast with the same revision.
    if (this.broadcasts === broadcastsAtRequest || snapshot.progress.revision > (this.snapshot()?.progress.revision ?? -1)) {
      this.acceptSnapshot(snapshot);
    }
  }

  private acceptSnapshot(snapshot: TutorialSnapshot): void {
    const previous = this.snapshot();
    if (previous && snapshot.progress.revision < previous.progress.revision) return;
    // Nothing else moves a snoozed tour, so a newer revision is the user's Settings choice.
    if (previous && snapshot.progress.revision > previous.progress.revision) this.paused.set(false);
    const oldKey = previous && `${previous.progress.revision}:${previous.ownerId}:${previous.requestedWindow}`;
    const newKey = `${snapshot.progress.revision}:${snapshot.ownerId}:${snapshot.requestedWindow}`;
    if (oldKey !== newKey) this.attemptedClaim = '';
    this.snapshot.set(snapshot);
    if (this.leaseId() !== null && snapshot.ownerId !== this.leaseId()) this.leaseId.set(null);
    this.maybeClaim();
  }

  private maybeClaim(): void {
    const role = this.role();
    const snapshot = this.snapshot();
    if (!role || !snapshot || this.destroyed || this.busy() || this.paused() || this.ownsLease()) return;
    if (role === 'home' && !this.homeRestored()) return;
    if (!snapshot.progress.active && !this.hasUnresolved()) return;
    if (snapshot.ownerId === null) {
      if (snapshot.requestedWindow && snapshot.requestedWindow !== role) return;
      if (role !== 'home' && snapshot.requestedWindow !== role) return;
    }
    // A reload keeps the same webContents lease but loses renderer-local state. A claim is
    // reentrant for that sender and harmlessly denied for every other window; never infer
    // ownership just from an opaque ownerId.
    const key = `${role}:${snapshot.progress.revision}:${snapshot.ownerId}:${snapshot.requestedWindow}`;
    if (this.attemptedClaim === key) return;
    this.attemptedClaim = key;
    void this.claim(role);
  }

  private async claim(role: TutorialWindow): Promise<void> {
    this.busy.set(true);
    const epoch = this.epoch;
    const broadcasts = this.broadcasts;
    try {
      const result = await this.electron.claimTutorial(role);
      if (this.epoch !== epoch || this.destroyed) {
        // A new route may already have reentered this same webContents lease. An old
        // claim response must not release the new route's successfully acquired lease.
        if (result.acquired && !this.ownsLease()) void this.electron.releaseTutorial().catch(() => {});
        return;
      }
      this.acceptResponse(result.snapshot, broadcasts);
      if (result.acquired && result.snapshot.ownerId !== null && this.snapshot()?.ownerId === result.snapshot.ownerId) {
        this.leaseId.set(result.snapshot.ownerId);
        this.message.set('');
      }
    } catch {
      if (this.epoch === epoch && !this.destroyed) this.message.set('Could not acquire the tour. Retry when the app is ready.');
    } finally {
      if (this.epoch === epoch && !this.destroyed) {
        this.busy.set(false);
        this.maybeClaim();
      }
    }
  }

  private async transition(action: TutorialAction): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !isTutorialProgressSupported(snapshot.progress) || !this.ownsLease() || this.busy()) return;
    const before = snapshot.progress.active;
    if (before && (!this.descriptor() || isTutorialPhaseResolved(snapshot.progress.phases[before.phaseId]))) return;
    const role = this.role();
    // Only an installed, verified engine and an idle window may be closed on explicit advance.
    const mayCloseDependencies = role === 'dependencies' && action === 'advance' &&
      before?.phaseId === 'local-engine' && before.stepId === 'engine-install' && this.canCloseIdleDependencies();
    this.busy.set(true);
    this.message.set('');
    const epoch = this.epoch;
    const broadcasts = this.broadcasts;
    try {
      const request: TutorialTransition = { action, expectedRevision: snapshot.progress.revision };
      if (action === 'advance' && before?.phaseId === 'local-source' && before.stepId === 'sources-add') {
        const source = document.querySelector<HTMLElement>('[data-tutorial="settings-sources-nav"]');
        const id = source?.getAttribute('data-tutorial-source-id');
        const isDraft = source?.getAttribute('data-tutorial-source-state') === 'draft';
        if (source?.getAttribute('data-tutorial-source-kind') === 'managed-local' && id &&
            (isDraft || id === this.observedSourceId)) {
          request.sourceId = id;
        }
      }
      const result = await this.electron.transitionTutorial(request);
      if (this.epoch !== epoch || this.destroyed) return;
      this.acceptResponse(result.snapshot, broadcasts);
      if (!result.applied) {
        this.message.set('The tour changed in another window. Review the current step and try again.');
        return;
      }
      // Never hand off or close a window for an obsolete result or a lease we no longer own.
      if (!this.ownsLease() || this.snapshot()?.progress.revision !== result.snapshot.progress.revision) return;
      const cursor = result.snapshot.progress.active;
      const next = tutorialStepFor(cursor);
      if (!cursor) {
        await this.releaseTo(undefined, null, epoch);
      } else if (next && next.window !== role) {
        await this.releaseTo(next.window, cursor, epoch);
        if (mayCloseDependencies && next.window === 'home' && this.canCloseIdleDependencies()) {
          this.electron.closeDependenciesWindow();
        }
      }
    } catch {
      if (this.epoch === epoch && !this.destroyed) this.message.set('Could not update the tour. Retry; your progress was not intentionally dismissed.');
    } finally {
      if (this.epoch === epoch && !this.destroyed) {
        this.busy.set(false);
        this.maybeClaim();
      }
    }
  }

  private async releaseTo(target: TutorialWindow | undefined, cursor: TutorialCursor | null, epoch: number): Promise<void> {
    if (!this.ownsLease()) return;
    const broadcasts = this.broadcasts;
    const snapshot = await this.electron.releaseTutorial(target);
    if (this.epoch !== epoch || this.destroyed) return;
    this.leaseId.set(null);
    this.acceptResponse(snapshot, broadcasts);
    if (target) this.openDestination(target, cursor);
  }

  private openDestination(target: TutorialWindow, cursor: TutorialCursor | null): void {
    if (target === 'dependencies') this.electron.openDependenciesWindow();
    if (target === 'settings') {
      this.electron.openSettingsWindow(cursor?.phaseId === 'featured-models' ? 'modelManager' : 'models');
    }
    // There is no focus-main IPC. Home claims the lease; the user can switch to the main window.
  }

  private canCloseIdleDependencies(): boolean {
    const state = document.querySelector<HTMLElement>('[data-tutorial-llama-state][data-tutorial-dependencies-busy]');
    const engine = state?.getAttribute('data-tutorial-llama-state');
    return (engine === 'success' || engine === 'installed') &&
      state?.getAttribute('data-tutorial-llama-busy') === 'false' &&
      state.getAttribute('data-tutorial-dependencies-busy') === 'false';
  }
}
