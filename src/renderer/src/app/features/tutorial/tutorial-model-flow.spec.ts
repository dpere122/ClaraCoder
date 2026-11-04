import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HuggingFaceModelDetails,
  HuggingFaceOwnerInfo,
  ModelManagerFileEntry,
  ModelManagerHfDetailsResult,
  ModelManagerHfFilesResult,
} from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { ThemeEngineService } from '../../core/theme/theme-engine.service';
import { lucideAppProviders } from '../../lucide-setup';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { SettingsStore, type ModelManagerSelection } from '../settings/settings/settings-store';
import { FEATURED_HF_MODELS, smallestLowModel } from '../settings/settings-model-manager/hf-models';
import { SettingsModelManager } from '../settings/settings-model-manager/settings-model-manager';
import { SettingsThemesStore } from '../settings/settings-themes/settings-themes-store';

const SMALL = smallestLowModel(FEATURED_HF_MODELS)!;
const LARGEST = FEATURED_HF_MODELS.reduce((a, b) => (b.totalParametersB > a.totalParametersB ? b : a));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const localModel: ModelManagerFileEntry = {
  fileName: 'local.gguf', absolutePath: '/models/local.gguf', sizeBytes: 1, modifiedMs: 0, source: 'custom',
};

function setup(selection: ModelManagerSelection | null = null) {
  const files = deferred<ModelManagerHfFilesResult>();
  const details = deferred<ModelManagerHfDetailsResult>();
  const electron = {
    modelManagerListHfFiles: vi.fn((_payload: { id: string; token?: string }) => files.promise),
    modelManagerHfModelDetails: vi.fn((_payload: { id: string; token?: string }) => details.promise),
    modelManagerDownloadHfFile: vi.fn().mockResolvedValue({ ok: true, absolutePath: '/models/download.gguf' }),
  };
  TestBed.configureTestingModule({
    imports: [SettingsModelManager],
    providers: [
      ...lucideAppProviders,
      SettingsStore,
      { provide: ElectronService, useValue: electron },
      { provide: ThemedConfirmDialogService, useValue: {} },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      { provide: SettingsThemesStore, useValue: { attach: vi.fn(), syncSelectionFromHost: vi.fn(), cancelPreview: vi.fn() } },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  store.modelManagerCustomModels.set([localModel]);
  store.modelManagerSelection.set(selection);
  const fixture = TestBed.createComponent(SettingsModelManager);
  fixture.detectChanges();
  return { store, fixture, el: fixture.nativeElement as HTMLElement, electron, files, details };
}

function tutorialStep(phaseId = 'featured-models', stepId = 'featured-preview'): void {
  window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId, stepId } }));
}

function row(el: HTMLElement, id: string): HTMLElement {
  const element = el.querySelector<HTMLElement>(`[data-row-key="hf:${id}"]`);
  expect(element, `missing row ${id}`).not.toBeNull();
  return element!;
}

function target(el: HTMLElement, name: string): HTMLElement {
  const element = el.querySelector<HTMLElement>(`[data-tutorial="${name}"]`);
  expect(element, `missing tutorial target ${name}`).not.toBeNull();
  return element!;
}

async function flush(fixture: ComponentFixture<SettingsModelManager>): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  fixture.detectChanges();
}

function owner(name: string, fullname: string): HuggingFaceOwnerInfo {
  return { name, fullname, kind: 'org', avatarDataUrl: null, verified: false, numModels: null, numFollowers: null, details: '' };
}

function modelDetails(id: string, profiles = true): HuggingFaceModelDetails {
  return {
    id, author: 'test-uploader', downloads: 0, likes: 0, createdAt: '', lastModified: '', license: '',
    baseModels: [], pipelineTag: '', architecture: '', parameterCount: null, contextLength: null,
    storageBytes: null, gated: false, private: false, tags: [],
    provider: profiles ? owner('test-provider', 'Test provider') : null,
    uploader: profiles ? owner('test-uploader', 'Test uploader') : null,
  };
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => TestBed.resetTestingModule());

describe('featured-model tutorial preparation', () => {
  it('only previews a visible Low model on the exact step, without downloading', () => {
    const { store, fixture, el, electron } = setup();
    const download = vi.spyOn(store, 'downloadHfQuant');
    const list = target(el, 'featured-list');
    const small = row(el, SMALL.id);
    const largest = row(el, LARGEST.id);
    expect(list.contains(target(el, 'featured-low'))).toBe(true);
    expect(target(el, 'featured-low').contains(small)).toBe(true);
    expect(target(el, 'featured-moe').contains(largest)).toBe(true);
    expect(largest.getAttribute('data-total-parameters-b')).toBe(String(LARGEST.totalParametersB));
    expect(largest.getAttribute('data-active-parameters-b')).toBe(String(LARGEST.activeParametersB));
    expect(largest.getAttribute('data-architecture')).toBe(LARGEST.architecture);

    tutorialStep('local-engine', 'featured-preview');
    tutorialStep('featured-models', 'featured-low');
    tutorialStep('featured-models', 'featured-quantizations');
    window.dispatchEvent(new Event('clara-tutorial-step'));
    expect(store.modelManagerSelection()).toBeNull();
    expect(electron.modelManagerListHfFiles).not.toHaveBeenCalled();
    expect(electron.modelManagerHfModelDetails).not.toHaveBeenCalled();

    tutorialStep();
    tutorialStep();
    fixture.detectChanges();
    expect(store.modelManagerSelection()).toEqual({ kind: 'hf', id: SMALL.id });
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledTimes(1);
    expect(electron.modelManagerHfModelDetails).toHaveBeenCalledTimes(1);
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledWith({ id: SMALL.id, token: '' });
    expect(small.getAttribute('aria-selected')).toBe('true');
    expect(target(el, 'featured-provider').textContent).toContain(SMALL.maker);
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('loading');
    expect(target(el, 'featured-uploader').textContent).toContain(SMALL.id);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('loading');
    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('loading');
    expect(download).not.toHaveBeenCalled();
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it.each<ModelManagerSelection>([
    { kind: 'hf', id: LARGEST.id },
    { kind: 'local', path: localModel.absolutePath },
  ])('preserves an existing $kind selection', (selection) => {
    const { store, fixture, electron } = setup(selection);
    tutorialStep();
    fixture.detectChanges();
    expect(store.modelManagerSelection()).toEqual(selection);
    expect(electron.modelManagerListHfFiles).not.toHaveBeenCalled();
    expect(electron.modelManagerHfModelDetails).not.toHaveBeenCalled();
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it('does not undo an intentional selection, even if it was subsequently cleared', () => {
    const { store, fixture, el, electron } = setup();
    row(el, LARGEST.id).click();
    tutorialStep();
    fixture.detectChanges();
    expect(store.modelManagerSelection()).toEqual({ kind: 'hf', id: LARGEST.id });
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledTimes(1);
    store.modelManagerSelection.set(null);
    tutorialStep();
    fixture.detectChanges();
    expect(store.modelManagerSelection()).toBeNull();
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledTimes(1);
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it('keeps a later user selection while earlier metadata requests complete', async () => {
    const { store, fixture, el, electron, files, details } = setup();
    const nextFiles = deferred<ModelManagerHfFilesResult>();
    const nextDetails = deferred<ModelManagerHfDetailsResult>();
    electron.modelManagerListHfFiles.mockImplementation(({ id }) => id === SMALL.id ? files.promise : nextFiles.promise);
    electron.modelManagerHfModelDetails.mockImplementation(({ id }) => id === SMALL.id ? details.promise : nextDetails.promise);

    tutorialStep();
    fixture.detectChanges();
    row(el, LARGEST.id).click();
    fixture.detectChanges();
    expect(store.modelManagerSelection()).toEqual({ kind: 'hf', id: LARGEST.id });

    files.resolve({ ok: true, files: [{ fileName: 'first-Q4.gguf', quant: 'Q4', sizeBytes: 1 }] });
    details.resolve({ ok: true, details: modelDetails(SMALL.id) });
    await flush(fixture);
    expect(el.querySelector('.mm-panel')?.getAttribute('data-repo-id')).toBe(LARGEST.id);
    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('loading');
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('loading');
    expect(el.textContent).not.toContain('first-Q4.gguf');
    expect(el.textContent).not.toContain('Test provider');

    nextFiles.reject(new Error('Selected repo unavailable'));
    nextDetails.resolve({ ok: true, details: modelDetails(LARGEST.id, false) });
    await flush(fixture);
    tutorialStep();
    expect(store.modelManagerSelection()).toEqual({ kind: 'hf', id: LARGEST.id });
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('error');
    expect(target(el, 'featured-quantizations').textContent).toContain('Selected repo unavailable');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('unavailable');
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledTimes(2);
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });
  it('updates the preview when filtering changes the visible catalog, including a single-row catalog', () => {
    const { store, fixture, el } = setup();
    store.modelManagerHfQuery.set('gemma');
    fixture.detectChanges();
    const visible = FEATURED_HF_MODELS.filter((model) => model.id.toLowerCase().includes('gemma'));
    const lightest = smallestLowModel(visible);
    expect(target(el, 'featured-low').contains(row(el, lightest!.id))).toBe(true);
    tutorialStep();
    expect(store.modelManagerSelection()).toEqual({ kind: 'hf', id: lightest?.id });

    store.modelManagerHfQuery.set(SMALL.id.split('/')[1]!.replace(/-GGUF$/i, ''));
    fixture.detectChanges();
    expect(target(el, 'featured-low').contains(row(el, SMALL.id))).toBe(true);
    expect(el.querySelector('[data-tutorial="featured-moe"]')).toBeNull();
  });

  it('does not disturb a search with no visible Low model or existing Hub results', () => {
    const { store, fixture, el, electron } = setup();
    store.modelManagerHfQuery.set('mistral');
    fixture.detectChanges();
    expect(el.querySelector('[data-tutorial="featured-low"]')).toBeNull();
    tutorialStep();
    expect(store.modelManagerSelection()).toBeNull();

    store.modelManagerHfQuery.set('qwen');
    store.modelManagerHfRawResults.set([{
      id: 'some/result', downloads: 0, likes: 0, lastModified: '', private: false, gated: false, tags: [],
    }]);
    fixture.detectChanges();
    expect(el.querySelector('[data-tutorial="featured-list"]')).toBeNull();
    tutorialStep();
    expect(store.modelManagerSelection()).toBeNull();
    expect(store.modelManagerHfQuery()).toBe('qwen');
    expect(electron.modelManagerListHfFiles).not.toHaveBeenCalled();
  });

  it('moves targets to actual profiles and offers downloads only after a click', async () => {
    const { store, fixture, el, electron, files, details } = setup();
    store.modelManagerCustomDir.set('/models');
    tutorialStep();
    files.resolve({ ok: true, files: [{ fileName: 'test-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 12 }] });
    details.resolve({ ok: true, details: modelDetails(SMALL.id) });
    await flush(fixture);

    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('ready');
    expect(target(el, 'featured-provider').textContent).toContain('Test provider');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('ready');
    expect(target(el, 'featured-uploader').textContent).toContain('Test uploader');
    expect(el.querySelectorAll('[data-tutorial="featured-provider"]').length).toBe(1);
    expect(el.querySelectorAll('[data-tutorial="featured-uploader"]').length).toBe(1);
    const quants = target(el, 'featured-quantizations');
    expect(quants.getAttribute('data-state')).toBe('ready');
    expect(quants.textContent).toContain('Q4_K_M');
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
    (quants.querySelector('button') as HTMLButtonElement).click();
    await flush(fixture);
    expect(electron.modelManagerDownloadHfFile).toHaveBeenCalledExactlyOnceWith({
      repoId: SMALL.id, fileName: 'test-Q4_K_M.gguf', customDir: '/models', token: '',
    });
  });

  it('reports asynchronous failures without presenting an empty or invented result', async () => {
    const { fixture, el, electron, files, details } = setup();
    tutorialStep();
    files.resolve({ ok: false, error: 'File listing failed' });
    details.reject(new Error('Profile lookup failed'));
    await flush(fixture);

    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('error');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('error');
    expect(target(el, 'featured-uploader').getAttribute('data-state')).toBe('error');
    const quants = target(el, 'featured-quantizations');
    expect(quants.getAttribute('data-state')).toBe('error');
    expect(quants.textContent).toContain('File listing failed');
    expect(quants.textContent).not.toContain('0 GGUF');
    expect(quants.textContent).not.toContain('No GGUF quant files found');
    expect(el.textContent).toContain('Profile lookup failed');
    expect(el.querySelectorAll('.mm-owner')).toHaveLength(0);
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it('does not mistake an error with no message for a successful empty response', async () => {
    const { fixture, el, files, details } = setup();
    tutorialStep();
    files.resolve({ ok: false, error: '' });
    details.reject(new Error());
    await flush(fixture);
    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('error');
    expect(el.textContent).toContain('Could not load Hugging Face details.');
    const quants = target(el, 'featured-quantizations');
    expect(quants.getAttribute('data-state')).toBe('error');
    expect(quants.textContent).toContain('Could not load GGUF quant files.');
    expect(quants.textContent).not.toContain('No GGUF quant files found');
  });
  it('retries a failed file listing even when the error message is empty', async () => {
    const { fixture, el, electron, files, details } = setup();
    tutorialStep();
    files.resolve({ ok: false, error: '' });
    details.resolve({ ok: true, details: modelDetails(SMALL.id) });
    await flush(fixture);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('error');

    const retry = deferred<ModelManagerHfFilesResult>();
    electron.modelManagerListHfFiles.mockReturnValueOnce(retry.promise);
    row(el, SMALL.id).click();
    fixture.detectChanges();
    expect(electron.modelManagerListHfFiles).toHaveBeenCalledTimes(2);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('loading');
    retry.resolve({ ok: true, files: [] });
    await flush(fixture);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('empty');
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it('returns to loading and then ready when the user retries a failed preview', async () => {
    const { fixture, el, electron, files, details } = setup();
    tutorialStep();
    files.resolve({ ok: false, error: 'First file request failed' });
    details.resolve({ ok: false, error: 'First profile request failed' });
    await flush(fixture);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('error');

    const retryFiles = deferred<ModelManagerHfFilesResult>();
    const retryDetails = deferred<ModelManagerHfDetailsResult>();
    electron.modelManagerListHfFiles.mockReturnValueOnce(retryFiles.promise);
    electron.modelManagerHfModelDetails.mockReturnValueOnce(retryDetails.promise);
    row(el, SMALL.id).click();
    fixture.detectChanges();
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('loading');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('loading');
    expect(target(el, 'featured-quantizations').textContent).not.toContain('0 GGUF');

    retryFiles.resolve({ ok: true, files: [{ fileName: 'retry-Q4.gguf', quant: 'Q4', sizeBytes: 1 }] });
    retryDetails.resolve({ ok: true, details: modelDetails(SMALL.id) });
    await flush(fixture);
    expect(target(el, 'featured-quantizations').getAttribute('data-state')).toBe('ready');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('ready');
    expect(target(el, 'featured-quantizations').textContent).toContain('Q4');
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
  });

  it('distinguishes a successful empty response and missing profiles from failures', async () => {
    const { fixture, el, files, details } = setup();
    tutorialStep();
    files.resolve({ ok: true, files: [] });
    details.resolve({ ok: true, details: modelDetails(SMALL.id, false) });
    await flush(fixture);
    expect(el.querySelector('.mm-panel')?.getAttribute('data-details-state')).toBe('ready');
    expect(target(el, 'featured-provider').getAttribute('data-state')).toBe('unavailable');
    expect(target(el, 'featured-uploader').getAttribute('data-state')).toBe('unavailable');
    const quants = target(el, 'featured-quantizations');
    expect(quants.getAttribute('data-state')).toBe('empty');
    expect(quants.textContent).toContain('No GGUF quant files found');
    expect(el.querySelectorAll('.mm-owner')).toHaveLength(0);
  });

  it('removes its window listener when the manager is destroyed', () => {
    const { store, fixture, electron } = setup();
    fixture.destroy();
    tutorialStep();
    expect(store.modelManagerSelection()).toBeNull();
    expect(electron.modelManagerListHfFiles).not.toHaveBeenCalled();
  });
});
