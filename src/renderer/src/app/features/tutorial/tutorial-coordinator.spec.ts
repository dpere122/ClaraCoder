import { createEnvironmentInjector, EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTutorialTransition,
  createDefaultTutorialProgress,
  TUTORIAL_PHASE_REGISTRY,
  type TutorialProgress,
  type TutorialSnapshot,
  type TutorialTransition,
  type TutorialWindow,
} from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { TutorialCoordinator } from './tutorial-coordinator';
import { TUTORIAL_STEPS } from './tutorial-steps';

class TutorialBackend {
  progress: TutorialProgress = createDefaultTutorialProgress();
  ownerId: number | null = null;
  requestedWindow: TutorialWindow | null = null;
  private readonly listeners = new Map<number, (snapshot: TutorialSnapshot) => void>();

  snapshot(): TutorialSnapshot {
    return structuredClone({ progress: this.progress, ownerId: this.ownerId, requestedWindow: this.requestedWindow });
  }

  broadcast(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners.values()) queueMicrotask(() => listener(structuredClone(snapshot)));
  }

  client(id: number, role: TutorialWindow) {
    return {
      isElectron: true,
      getTutorialSnapshot: vi.fn(async () => this.snapshot()),
      onTutorialUpdated: vi.fn((callback: (snapshot: TutorialSnapshot) => void) => {
        this.listeners.set(id, callback);
        return () => this.listeners.delete(id);
      }),
      claimTutorial: vi.fn(async (requested: TutorialWindow) => {
        if (requested !== role) throw new Error('wrong role');
        if (this.ownerId === null && (!this.requestedWindow || this.requestedWindow === role)) {
          this.ownerId = id;
          this.requestedWindow = null;
          this.broadcast();
        }
        return { acquired: this.ownerId === id, snapshot: this.snapshot() };
      }),
      transitionTutorial: vi.fn(async (request: TutorialTransition) => {
        const result = this.ownerId === id
          ? applyTutorialTransition(this.progress, request)
          : { applied: false, progress: this.progress };
        this.progress = result.progress;
        if (result.applied) this.broadcast();
        return { applied: result.applied, snapshot: this.snapshot() };
      }),
      releaseTutorial: vi.fn(async (requested?: TutorialWindow) => {
        if (this.ownerId === id) {
          this.ownerId = null;
          this.requestedWindow = requested ?? null;
          this.broadcast();
        }
        return this.snapshot();
      }),
      openDependenciesWindow: vi.fn(),
      closeDependenciesWindow: vi.fn(),
      openSettingsWindow: vi.fn(),
      setCurrentWorkspace: vi.fn(),
      saveConfig: vi.fn(),
    };
  }
}

const environments: EnvironmentInjector[] = [];

function renderer(backend: TutorialBackend, role: TutorialWindow, id: number, homeReady = true) {
  const client = backend.client(id, role);
  const env = createEnvironmentInjector([{ provide: ElectronService, useValue: client }], TestBed.inject(EnvironmentInjector));
  environments.push(env);
  const coordinator = runInInjectionContext(env, () => new TutorialCoordinator());
  if (role === 'home' && homeReady) coordinator.markHomeRestored();
  coordinator.enterWindow(role);
  return { coordinator, client };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

function setCursor(backend: TutorialBackend, phaseId: string, stepId: string): void {
  const index = TUTORIAL_PHASE_REGISTRY.findIndex((phase) => phase.id === phaseId);
  const phases = Object.fromEntries(TUTORIAL_PHASE_REGISTRY.slice(0, Math.max(index, 0)).map((phase) => [phase.id, 'completed' as const]));
  backend.progress = { revision: 4, phases, active: { phaseId, stepId } };
}

function dependencyState(state: string, busy = 'false', llamaBusy = 'false'): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('data-tutorial-llama-state', state);
  element.setAttribute('data-tutorial-llama-busy', llamaBusy);
  element.setAttribute('data-tutorial-dependencies-busy', busy);
  document.body.appendChild(element);
  return element;
}

beforeEach(() => TestBed.configureTestingModule({}));
afterEach(() => {
  for (const env of environments.splice(0)) env.destroy();
  document.querySelectorAll('[data-tutorial-llama-state], [data-tutorial="settings-sources-nav"]').forEach((el) => el.remove());
  TestBed.resetTestingModule();
});

describe('tutorial descriptors', () => {
  it('covers the durable registry exactly once and in its stable order', () => {
    const registry = TUTORIAL_PHASE_REGISTRY.flatMap((phase) => phase.steps.map((stepId) => `${phase.id}:${stepId}`));
    expect(TUTORIAL_STEPS.map((step) => `${step.phaseId}:${step.stepId}`)).toEqual(registry);
    expect(new Set(registry).size).toBe(registry.length);
    expect(TUTORIAL_STEPS.find((step) => step.stepId === 'tour-complete')?.complete).toBe(true);
  });
  it('teaches Home navigation in order and highlights provider and uploader separately', () => {
    const intro = TUTORIAL_STEPS.filter((step) => step.phaseId === 'intro');
    expect(intro.map((step) => step.stepId)).toEqual([
      'welcome', 'home-start', 'home-workspace', 'home-navigation', 'home-models', 'home-dependencies',
    ]);
    expect(intro.find((step) => step.stepId === 'home-navigation')?.targets?.[0]).toBe('home-sources');
    expect(intro.find((step) => step.stepId === 'home-models')?.targets?.[0]).toBe('home-model-manager');
    expect(TUTORIAL_STEPS.find((step) => step.stepId === 'featured-preview')?.targets).toEqual(['featured-provider']);
    expect(TUTORIAL_STEPS.find((step) => step.stepId === 'featured-uploader')?.targets).toEqual(['featured-uploader']);
    expect(TUTORIAL_STEPS.find((step) => step.stepId === 'sources-defaults')?.details).toContain('Advanced → Inference');
  });
  it('keeps technical terms out of the main text, in the collapsed details', () => {
    const jargon = /GGUF|Hugging Face|metadata|inference|quantiz|semantic|runtime|draft/i;
    expect(TUTORIAL_STEPS.filter((step) => jargon.test(`${step.title} ${step.body}`)).map((step) => step.stepId)).toEqual([]);
  });
  it('uses straight quotes, which keep their natural width in every App font', () => {
    const copy = TUTORIAL_STEPS.flatMap((step) => [step.title, step.body, step.details ?? '', step.unavailableHint ?? '']);
    expect(copy.filter((text) => /[‘’“”]/.test(text))).toEqual([]);
  });
});

describe('TutorialCoordinator', () => {
  it('waits for actual Home restoration before acquiring or offering the invitation', async () => {
    const backend = new TutorialBackend();
    const { coordinator, client } = renderer(backend, 'home', 1, false);
    await flush();
    expect(client.getTutorialSnapshot).toHaveBeenCalledOnce();
    expect(client.claimTutorial).not.toHaveBeenCalled();
    expect(coordinator.view()).toBe('hidden');

    coordinator.markHomeRestored();
    await flush();
    expect(client.claimTutorial).toHaveBeenCalledWith('home');
    expect(coordinator.view()).toBe('invitation');
    expect(client.setCurrentWorkspace).not.toHaveBeenCalled();
    expect(client.saveConfig).not.toHaveBeenCalled();
  });

  it('only the lease holder renders or mutates a step', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'intro', 'home-start');
    backend.ownerId = 99;
    const { coordinator, client } = renderer(backend, 'home', 1);
    await flush();
    expect(coordinator.view()).toBe('hidden');
    await coordinator.advance();
    await coordinator.dismissAll();
    expect(client.transitionTutorial).not.toHaveBeenCalled();
    expect(client.claimTutorial).toHaveBeenCalledWith('home'); // A reentrant probe is denied for another owner.
  });

  it.each([
    ['home', 1, 'intro', 'home-start'],
    ['dependencies', 2, 'local-engine', 'engine-intro'],
    ['settings', 3, 'local-source', 'sources-navigation'],
  ] as const)('reclaims the same webContents lease after a %s renderer reload', async (role, id, phaseId, stepId) => {
    const backend = new TutorialBackend();
    setCursor(backend, phaseId, stepId);
    backend.ownerId = id; // A renderer reload need not destroy webContents.
    const { coordinator, client } = renderer(backend, role, id);
    await flush();
    expect(client.claimTutorial).toHaveBeenCalledWith(role);
    expect(coordinator.ownsLease()).toBe(true);
    expect(coordinator.view()).toBe('step');
    expect(coordinator.cursor()).toEqual({ phaseId, stepId });
    expect(client.transitionTutorial).not.toHaveBeenCalled();
  });

  it('recovers from a pending claim when the renderer route changes and reenters', async () => {
    const backend = new TutorialBackend();
    const client = backend.client(1, 'home');
    const claim = client.claimTutorial.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    client.claimTutorial.mockImplementationOnce(async (role) => {
      const result = await claim(role);
      await gate; // Main has granted the lease, but the first renderer response is delayed.
      return result;
    });
    const env = createEnvironmentInjector([{ provide: ElectronService, useValue: client }], TestBed.inject(EnvironmentInjector));
    environments.push(env);
    const coordinator = runInInjectionContext(env, () => new TutorialCoordinator());
    coordinator.markHomeRestored();
    coordinator.enterWindow('home');
    await flush();
    expect(coordinator.busy()).toBe(true);
    expect(backend.ownerId).toBe(1);

    coordinator.enterWindow(null);
    coordinator.enterWindow('home');
    await flush();
    expect(client.claimTutorial).toHaveBeenCalledTimes(2);
    expect(coordinator.busy()).toBe(false);
    expect(coordinator.view()).toBe('invitation');
    expect(coordinator.ownsLease()).toBe(true);

    resume();
    await flush();
    expect(client.releaseTutorial).not.toHaveBeenCalled();
    expect(backend.ownerId).toBe(1);
    expect(coordinator.ownsLease()).toBe(true);
  });

  it('uses the expected revision and surfaces a conflict without opening or advancing again', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'intro', 'home-dependencies');
    const { coordinator, client } = renderer(backend, 'home', 1);
    await flush();
    client.transitionTutorial.mockImplementationOnce(async () => {
      backend.progress = { ...backend.progress, revision: 5, active: { phaseId: 'intro', stepId: 'home-navigation' } };
      backend.broadcast();
      return { applied: false, snapshot: backend.snapshot() };
    });
    await coordinator.advance();
    await flush();
    expect(client.transitionTutorial).toHaveBeenCalledWith({ action: 'advance', expectedRevision: 4 });
    expect(coordinator.cursor()?.stepId).toBe('home-navigation');
    expect(coordinator.message()).toContain('changed');
    expect(client.releaseTutorial).not.toHaveBeenCalled();
    expect(client.openDependenciesWindow).not.toHaveBeenCalled();
  });

  it('ignores an old snapshot response that arrives after a newer ownership broadcast', async () => {
    const backend = new TutorialBackend();
    const client = backend.client(1, 'home');
    const initial = backend.snapshot();
    let resolve!: (snapshot: TutorialSnapshot) => void;
    client.getTutorialSnapshot.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const env = createEnvironmentInjector([{ provide: ElectronService, useValue: client }], TestBed.inject(EnvironmentInjector));
    environments.push(env);
    const coordinator = runInInjectionContext(env, () => new TutorialCoordinator());
    coordinator.markHomeRestored();
    coordinator.enterWindow('home');
    backend.ownerId = 77;
    backend.broadcast();
    await flush();
    resolve(initial);
    await flush();
    expect(coordinator.snapshot()?.ownerId).toBe(77);
    expect(client.claimTutorial).toHaveBeenCalledWith('home');
  });

  it('hands off Home to an already-open Dependencies window on an explicit action', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'intro', 'home-dependencies');
    const deps = renderer(backend, 'dependencies', 2);
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('step');
    expect(deps.coordinator.view()).toBe('hidden');
    expect(home.coordinator.handleHomeNavigation('dependencies')).toBe(true);
    await flush();
    expect(home.client.releaseTutorial).toHaveBeenCalledWith('dependencies');
    expect(home.client.openDependenciesWindow).toHaveBeenCalledOnce();
    expect(deps.coordinator.ownsLease()).toBe(true);
    expect(deps.coordinator.cursor()).toEqual({ phaseId: 'local-engine', stepId: 'engine-intro' });
    expect(home.coordinator.view()).toBe('hidden');
    expect(home.client.setCurrentWorkspace).not.toHaveBeenCalled();
  });

  it('follows the complete Home → Dependencies → Home → Settings handoff without changing a workspace', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'intro', 'home-dependencies');
    const home = renderer(backend, 'home', 1);
    const deps = renderer(backend, 'dependencies', 2);
    const settings = renderer(backend, 'settings', 3);
    await flush();
    await home.coordinator.advance();
    await flush();
    expect(deps.coordinator.cursor()?.stepId).toBe('engine-intro');
    await deps.coordinator.advance();
    await flush();
    expect(deps.coordinator.cursor()?.stepId).toBe('engine-install');
    await deps.coordinator.advance(); // Explicitly continue without an install.
    await flush();
    expect(home.coordinator.cursor()?.stepId).toBe('home-model-manager');
    expect(home.coordinator.ownsLease()).toBe(true);
    await home.coordinator.advance();
    await flush();
    expect(settings.coordinator.cursor()?.stepId).toBe('downloaded-list');
    expect(settings.coordinator.ownsLease()).toBe(true);
    expect(home.client.openSettingsWindow).toHaveBeenCalledWith('modelManager');
    expect(deps.client.closeDependenciesWindow).not.toHaveBeenCalled();
    expect(home.client.setCurrentWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['success', 'false', 'false', true],
    ['success', 'true', 'false', false],
    ['success', 'false', 'true', false],
    ['installed', 'false', 'false', true],
    ['installed', 'true', 'false', false],
    ['error', 'false', 'false', false],
    ['cancelled', 'false', 'false', false],
    ['installing', 'true', 'true', false],
  ])('closes Dependencies only for a verified, idle engine (%s, %s, %s)', async (state, busy, llamaBusy, closes) => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-engine', 'engine-install');
    backend.requestedWindow = 'dependencies';
    dependencyState(state, busy, llamaBusy);
    const deps = renderer(backend, 'dependencies', 2);
    await flush();
    await deps.coordinator.advance();
    await flush();
    expect(deps.client.releaseTutorial).toHaveBeenCalledWith('home');
    expect(deps.client.closeDependenciesWindow).toHaveBeenCalledTimes(closes ? 1 : 0);
    expect(backend.progress.active).toEqual({ phaseId: 'featured-models', stepId: 'home-model-manager' });
  });

  it('rechecks all dependency activity after an asynchronous handoff before closing', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-engine', 'engine-install');
    backend.requestedWindow = 'dependencies';
    const state = dependencyState('success');
    const deps = renderer(backend, 'dependencies', 2);
    await flush();
    const release = deps.client.releaseTutorial.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    deps.client.releaseTutorial.mockImplementationOnce(async (role) => {
      await gate;
      return release(role);
    });
    const advancing = deps.coordinator.advance();
    await flush();
    state.setAttribute('data-tutorial-dependencies-busy', 'true');
    resume();
    await advancing;
    expect(deps.client.closeDependenciesWindow).not.toHaveBeenCalled();
  });

  it('never closes Dependencies on skip, even if an install succeeded', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-engine', 'engine-install');
    backend.requestedWindow = 'dependencies';
    dependencyState('success');
    const deps = renderer(backend, 'dependencies', 2);
    await flush();
    await deps.coordinator.skipPhase();
    expect(backend.progress.phases['local-engine']).toBe('skipped');
    expect(deps.client.closeDependenciesWindow).not.toHaveBeenCalled();
  });

  it('recovers an orphan without dismissing or advancing and lets Home reopen its window', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-engine', 'engine-install');
    backend.ownerId = 2;
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('hidden');
    backend.ownerId = null; // The owning BrowserWindow closed.
    backend.broadcast();
    await flush();
    expect(home.coordinator.ownsLease()).toBe(true);
    expect(home.coordinator.view()).toBe('handoff');
    await home.coordinator.handoff();
    await flush();
    expect(home.client.openDependenciesWindow).toHaveBeenCalledOnce();
    expect(home.client.transitionTutorial).not.toHaveBeenCalled();
    expect(backend.progress.active?.stepId).toBe('engine-install');
    expect(backend.progress.phases).toEqual({ intro: 'completed' });
  });

  it('can reopen a reserved window without claiming or mutating it', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'featured-models', 'featured-intro');
    backend.requestedWindow = 'settings';
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('recovery');
    home.coordinator.reopenRequested();
    expect(home.client.openSettingsWindow).toHaveBeenCalledWith('modelManager');
    expect(home.client.claimTutorial).not.toHaveBeenCalled();
    expect(home.client.transitionTutorial).not.toHaveBeenCalled();
  });

  it('moves from featured models to Sources within Settings without applying a draft or switching tabs', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'featured-models', 'featured-quantizations');
    backend.requestedWindow = 'settings';
    const settings = renderer(backend, 'settings', 3);
    await flush();
    await settings.coordinator.advance();
    expect(settings.coordinator.cursor()).toEqual({ phaseId: 'local-source', stepId: 'sources-navigation' });
    expect(settings.client.openSettingsWindow).not.toHaveBeenCalled();
    expect(settings.client.saveConfig).not.toHaveBeenCalled();
  });

  it('remembers only the ID of a user-created draft and allows explicit lost-draft recovery', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-source', 'sources-add');
    backend.requestedWindow = 'settings';
    const nav = document.createElement('button');
    nav.setAttribute('data-tutorial', 'settings-sources-nav');
    nav.setAttribute('data-tutorial-source-id', 'draft-123');
    nav.setAttribute('data-tutorial-source-state', 'draft');
    nav.setAttribute('data-tutorial-source-kind', 'managed-local');
    document.body.appendChild(nav);
    const settings = renderer(backend, 'settings', 3);
    await flush();
    await settings.coordinator.advance();
    expect(settings.client.transitionTutorial).toHaveBeenCalledWith({ action: 'advance', expectedRevision: 4, sourceId: 'draft-123' });
    expect(backend.progress.active?.stepId).toBe('sources-model');
    expect(backend.progress.sourceId).toBe('draft-123');
    await settings.coordinator.recoverSource();
    expect(backend.progress.active?.stepId).toBe('sources-add');
    expect(backend.progress.sourceId).toBeUndefined();
    expect(settings.client.saveConfig).not.toHaveBeenCalled();
  });

  it('retains a source identity if the user applies it before leaving Add source', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'local-source', 'sources-add');
    backend.requestedWindow = 'settings';
    const nav = document.createElement('button');
    nav.setAttribute('data-tutorial', 'settings-sources-nav');
    nav.setAttribute('data-tutorial-source-id', 'draft-123');
    nav.setAttribute('data-tutorial-source-state', 'persisted');
    nav.setAttribute('data-tutorial-source-kind', 'managed-local');
    document.body.appendChild(nav);
    const settings = renderer(backend, 'settings', 3);
    await flush();
    settings.coordinator.noteSourceDraft('draft-123');
    await settings.coordinator.advance();
    expect(backend.progress.sourceId).toBe('draft-123');
    expect(settings.client.saveConfig).not.toHaveBeenCalled();
  });

  it.each([null, { phaseId: 'intro', stepId: 'home-start' }])(
    'keeps an unsupported future schema read-only even with a known or absent cursor',
    async (active) => {
      const backend = new TutorialBackend();
      backend.progress = { revision: 3, schemaVersion: 2, phases: {}, active };
      const home = renderer(backend, 'home', 1);
      await flush();
      expect(home.coordinator.view()).toBe('unsupported');
      await home.coordinator.start();
      await home.coordinator.advance();
      await home.coordinator.dismissAll();
      expect(home.client.transitionTutorial).not.toHaveBeenCalled();
      expect(backend.progress).toEqual({ revision: 3, schemaVersion: 2, phases: {}, active });
    },
  );

  it('shows an opaque phase record as unsupported instead of offering an invalid transition', async () => {
    const backend = new TutorialBackend();
    backend.progress = {
      revision: 3,
      phases: { intro: { futureResolution: 'paused' } },
      active: { phaseId: 'intro', stepId: 'home-start' },
    };
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('unsupported');
    await home.coordinator.advance();
    await home.coordinator.dismissAll();
    expect(home.client.transitionTutorial).not.toHaveBeenCalled();
    expect(backend.progress.phases['intro']).toEqual({ futureResolution: 'paused' });
  });

  it('offers a snoozed tour again after Settings restarts it, but not on a mere broadcast', async () => {
    const backend = new TutorialBackend();
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('invitation');
    await home.coordinator.later();
    await flush();
    expect(home.coordinator.view()).toBe('hidden');

    backend.broadcast();
    await flush();
    expect(home.coordinator.view()).toBe('hidden');

    backend.progress = { ...backend.progress, revision: backend.progress.revision + 1 };
    backend.broadcast();
    await flush();
    expect(home.coordinator.view()).toBe('invitation');
  });

  it('keeps unknown future cursors intact instead of silently skipping them', async () => {
    const backend = new TutorialBackend();
    setCursor(backend, 'future-phase', 'future-step');
    const home = renderer(backend, 'home', 1);
    await flush();
    expect(home.coordinator.view()).toBe('unsupported');
    await home.coordinator.later();
    expect(backend.progress.active).toEqual({ phaseId: 'future-phase', stepId: 'future-step' });
    expect(home.client.transitionTutorial).not.toHaveBeenCalled();
  });
});
