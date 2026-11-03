import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuggingFaceModelFile, ModelManagerFileEntry } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { lucideAppProviders } from '../../../lucide-setup';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsThemesStore } from '../settings-themes/settings-themes-store';
import { FEATURED_HF_MODELS, featuredModelExamples, type FeaturedHfModel } from './hf-models';
import { SettingsModelManager } from './settings-model-manager';

const REPO = 'ggml-org/gpt-oss-20b-GGUF';
const loose = (absolutePath: string): ModelManagerFileEntry => ({
  fileName: absolutePath.split('/').pop() as string,
  absolutePath,
  sizeBytes: 1,
  modifiedMs: 0,
  source: 'custom',
});

function setup() {
  TestBed.configureTestingModule({
    imports: [SettingsModelManager],
    providers: [
      ...lucideAppProviders,
      SettingsStore,
      { provide: ElectronService, useValue: {} },
      { provide: ThemedConfirmDialogService, useValue: {} },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      { provide: SettingsThemesStore, useValue: { attach: vi.fn(), syncSelectionFromHost: vi.fn(), cancelPreview: vi.fn() } },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  store.modelManagerHfDetailsById.set({ [REPO]: { ok: false, error: 'not asked' } });
  return { store, fixture: TestBed.createComponent(SettingsModelManager) };
}

async function render(fixture: ComponentFixture<SettingsModelManager>): Promise<HTMLElement> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

beforeEach(() => TestBed.resetTestingModule());

describe('the quant rows of a repo', () => {
  const FILES: HuggingFaceModelFile[] = [
    { fileName: 'gpt-oss-20b-MXFP4.gguf', quant: 'MXFP4', sizeBytes: 1 },
    { fileName: 'eagle3-gpt-oss-20b-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 1, role: 'draft' },
    { fileName: 'mtp-gpt-oss-20b-Q4_0.gguf', quant: 'Q4_0', sizeBytes: 1, role: 'mtp' },
    { fileName: 'mmproj-gpt-oss-20b-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 1, role: 'mmproj' },
  ];

  it('name each head, and offer only the model to Models once downloaded', async () => {
    const { store, fixture } = setup();
    store.modelManagerSelection.set({ kind: 'hf', id: REPO });
    store.modelManagerHfFilesByRepo.set({ [REPO]: FILES });
    store.modelManagerHfDownloaded.set(
      Object.fromEntries(FILES.map((f) => [`${REPO}/${f.fileName}`, `/models/${f.fileName}`])),
    );
    const el = await render(fixture);
    const rows = [...el.querySelectorAll('.model-quant-row')].map((row) => ({
      name: row.querySelector('.model-quant-row__name')?.textContent?.trim(),
      usable: [...row.querySelectorAll('button')].some((b) => b.textContent?.includes('Use in Models')),
    }));
    expect(rows).toEqual([
      { name: 'MXFP4', usable: true },
      { name: 'Draft head Q8_0', usable: false },
      { name: 'MTP head Q4_0', usable: false },
      { name: 'Vision projector Q8_0', usable: false },
    ]);
  });
});

describe('the panel of a downloaded model', () => {
  const panelFor = async (model: ModelManagerFileEntry) => {
    const { store, fixture } = setup();
    store.modelManagerCustomModels.set([model]);
    store.modelManagerSelection.set({ kind: 'local', path: model.absolutePath });
    const el = await render(fixture);
    return {
      usable: [...el.querySelectorAll('.mm-panel__actions button')].some((b) => b.textContent?.includes('Use in Models')),
      type: [...el.querySelectorAll('.mm-facts div')].find((row) => row.querySelector('dt')?.textContent === 'Type')?.querySelector('dd')
        ?.textContent,
    };
  };

  it.each([
    ['/models/gpt/eagle3-gpt-oss-20b-Q8_0.gguf', 'Draft head for a model'],
    ['/models/laguna/laguna-s-2.1-DFlash-BF16.gguf', 'Draft head for a model'],
    ['/models/gemma/mtp-gemma-4-12B-it-Q4_0.gguf', 'MTP head for a model'],
    ['/models/gemma/mmproj-gemma-4-12B-it-bf16.gguf', 'Vision projector for a model'],
  ])('does not offer the companion file %s to Models', async (path, type) => {
    expect(await panelFor(loose(path))).toEqual({ usable: false, type });
  });

  it('offers a model', async () => {
    expect(await panelFor(loose('/models/gpt/gpt-oss-20b-MXFP4.gguf'))).toEqual({ usable: true, type: 'GGUF file' });
  });

  it('offers a hub folder whatever its name says', async () => {
    const hub: ModelManagerFileEntry = { ...loose('/models/models--z-lab--Qwen3-4B-DFlash'), entryKind: 'hubRepo' };
    expect(await panelFor(hub)).toEqual({ usable: true, type: 'Hugging Face hub folder' });
  });
});

describe('the featured catalog', () => {
  it('records provider-reported total and active language-model parameters in billions', () => {
    expect(Object.fromEntries(FEATURED_HF_MODELS.map((model) => [model.id, {
      architecture: model.architecture,
      total: model.totalParametersB,
      active: model.activeParametersB,
    }]))).toEqual({
      'unsloth/Qwen3.8-27B-GGUF': { architecture: 'dense', total: 27, active: 27 },
      'unsloth/Qwen3.6-35B-A3B-GGUF': { architecture: 'moe', total: 35, active: 3 },
      'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF': { architecture: 'moe', total: 30.5, active: 3.3 },
      'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF': { architecture: 'dense', total: 24, active: 24 },
      'ggml-org/gpt-oss-20b-GGUF': { architecture: 'moe', total: 21, active: 3.6 },
      'unsloth/gemma-4-26B-A4B-it-GGUF': { architecture: 'moe', total: 25.2, active: 3.8 },
      'unsloth/gemma-4-12b-it-GGUF': { architecture: 'dense', total: 11.95, active: 11.95 },
      'unsloth/Qwen3.5-9B-GGUF': { architecture: 'dense', total: 9, active: 9 },
    });
    expect(new Set(FEATURED_HF_MODELS.map((model) => model.id)).size).toBe(FEATURED_HF_MODELS.length);
    for (const model of FEATURED_HF_MODELS) {
      expect(Number.isFinite(model.totalParametersB)).toBe(true);
      expect(model.activeParametersB).toBeGreaterThan(0);
      expect(model.architecture === 'dense' ? model.activeParametersB === model.totalParametersB : model.activeParametersB < model.totalParametersB).toBe(true);
    }
  });

  it('recomputes examples for catalog changes using total parameters, never display text or active MoE size', () => {
    const example = (id: string, tag: FeaturedHfModel['tag'], total: number, active: number): FeaturedHfModel => ({
      id, maker: 'Maker', size: 'This text is not a parameter count', tag,
      architecture: total === active ? 'dense' : 'moe', totalParametersB: total, activeParametersB: active,
    });
    const small = example('org/small', 'Small', 4, 4);
    const otherSmall = example('org/other-small', 'Small', 10, 10);
    const dense = example('org/dense', 'Coding', 40, 40);
    const largestMoe = example('org/largest-moe', 'General', 100, 2);
    const badSize = example('org/bad-size', 'Small', Number.NaN, 1);
    const badActive = example('org/bad-active', 'Small', 200, Number.NaN);
    const impossibleActive = example('org/impossible-active', 'General', 300, 301);

    expect(featuredModelExamples([dense, badSize, badActive, impossibleActive, otherSmall, largestMoe, small])).toEqual({ small, largest: largestMoe });
    expect(featuredModelExamples([largestMoe, dense])).toEqual({ small: null, largest: largestMoe });
    expect(featuredModelExamples([])).toEqual({ small: null, largest: null });
  });
});

describe('featured tutorial targets', () => {
  it('points to the smallest tagged model and the highest total parameter count in the visible list', async () => {
    const { store, fixture } = setup();
    const el = await render(fixture);
    const examples = featuredModelExamples(FEATURED_HF_MODELS);
    const small = el.querySelector<HTMLElement>('[data-tutorial="featured-small"]');
    const largest = el.querySelector<HTMLElement>('[data-tutorial="featured-largest"]');
    expect(small?.tagName).toBe('BUTTON');
    expect(small?.getAttribute('data-row-key')).toBe(`hf:${examples.small?.id}`);
    expect(largest?.getAttribute('data-row-key')).toBe(`hf:${examples.largest?.id}`);
    expect(Number(largest?.getAttribute('data-total-parameters-b'))).toBe(
      Math.max(...FEATURED_HF_MODELS.map((model) => model.totalParametersB)),
    );
    expect(store.modelManagerSelection()).toBeNull();

    store.modelManagerHfQuery.set('gemma');
    fixture.detectChanges();
    const visible = FEATURED_HF_MODELS.filter((model) => model.id.toLowerCase().includes('gemma'));
    const visibleExamples = featuredModelExamples(visible);
    expect(el.querySelector('[data-tutorial="featured-small"]')?.getAttribute('data-row-key')).toBe(`hf:${visibleExamples.small?.id}`);
    expect(el.querySelector('[data-tutorial="featured-largest"]')?.getAttribute('data-row-key')).toBe(`hf:${visibleExamples.largest?.id}`);
    expect(store.modelManagerSelection()).toBeNull();
    fixture.destroy();
  });

  it('only selects a visible Small preview on the preview event and never starts a download', () => {
    const { store, fixture } = setup();
    fixture.detectChanges();
    const select = vi.spyOn(store, 'selectHfModel').mockImplementation((id) => store.modelManagerSelection.set({ kind: 'hf', id }));
    const download = vi.spyOn(store, 'downloadHfQuant');
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-small' } }));
    expect(select).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-preview' } }));
    expect(select).toHaveBeenCalledExactlyOnceWith(featuredModelExamples(FEATURED_HF_MODELS).small?.id);
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-preview' } }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
