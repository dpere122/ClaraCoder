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
import { FEATURED_HF_MODELS, FEATURED_MODEL_GROUPS, featuredModelGroup, smallestSmallModel, type FeaturedHfModel } from './hf-models';
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

  it('groups by total parameters, never display text, with MoE models apart from size', () => {
    const model = (id: string, total: number, active = total): FeaturedHfModel => ({
      id, maker: 'Maker', size: 'This text is not a parameter count', tag: 'General',
      architecture: total === active ? 'dense' : 'moe', totalParametersB: total, activeParametersB: active,
    });
    expect(featuredModelGroup(model('org/a', 14.9))).toBe('small');
    expect(featuredModelGroup(model('org/b', 15))).toBe('medium');
    expect(featuredModelGroup(model('org/c', 25))).toBe('medium');
    expect(featuredModelGroup(model('org/d', 25.1))).toBe('large');
    expect(featuredModelGroup(model('org/e', 4, 2))).toBe('moe');
    expect(featuredModelGroup(model('org/f', 100, 2))).toBe('moe');
    const lightest = model('org/lightest', 4);
    expect(smallestSmallModel([model('org/big', 40), model('org/other', 10), lightest, model('org/moe', 2, 1)])).toBe(lightest);
    expect(smallestSmallModel([model('org/big', 40), model('org/moe', 2, 1)])).toBeNull();
    expect(smallestSmallModel([])).toBeNull();
  });

  it('puts every current model in the agreed group', () => {
    const groups = Object.fromEntries(FEATURED_MODEL_GROUPS.map((group) => [
      group.id,
      FEATURED_HF_MODELS.filter((model) => featuredModelGroup(model) === group.id).map((model) => model.totalParametersB).sort((a, b) => a - b),
    ]));
    expect(groups).toEqual({ small: [9, 11.95], medium: [24], large: [27], moe: [21, 25.2, 30.5, 35] });
  });
});

describe('the list sections', () => {
  const LOCAL: ModelManagerFileEntry = { fileName: 'my-qwen.gguf', absolutePath: '/models/my-qwen.gguf', sizeBytes: 1, modifiedMs: 0, source: 'custom' };
  const section = (el: HTMLElement, name: string): HTMLDetailsElement | null => el.querySelector(`details[data-tutorial="${name}"]`);
  /** Stands in for what the browser does when a heading is clicked. */
  const userToggle = async (fixture: ComponentFixture<SettingsModelManager>, details: HTMLDetailsElement, open: boolean): Promise<void> => {
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
    await render(fixture);
  };

  it('start collapsed with a chevron and open on request, with a note when nothing is downloaded', async () => {
    const { fixture } = setup();
    const el = await render(fixture);
    const downloaded = section(el, 'downloaded-list')!;
    const featured = section(el, 'featured-list')!;
    expect(downloaded.open).toBe(false);
    expect(featured.open).toBe(false);
    expect(downloaded.querySelector('summary .mm-accordion__chevron')).toBeTruthy();
    expect(downloaded.querySelector('summary')?.textContent).toContain('Downloaded');
    expect(featured.querySelector('summary .mm-accordion__count')?.textContent).toBe(String(FEATURED_HF_MODELS.length));
    expect(downloaded.textContent).toContain('Nothing downloaded yet.');

    await userToggle(fixture, featured, true);
    expect(section(el, 'featured-list')?.open).toBe(true);
    expect(section(el, 'downloaded-list')?.open).toBe(false);
    fixture.destroy();
  });

  it('open only where a search finds something, and go back to how they were when it clears', async () => {
    const { store, fixture } = setup();
    store.modelManagerCustomModels.set([LOCAL]);
    const el = await render(fixture);

    store.modelManagerHfQuery.set('my-qwen');
    fixture.detectChanges();
    expect(section(el, 'downloaded-list')?.open).toBe(true);
    expect(section(el, 'featured-list')).toBeNull();

    store.modelManagerHfQuery.set('gemma');
    fixture.detectChanges();
    expect(section(el, 'downloaded-list')).toBeNull();
    expect(section(el, 'featured-list')?.open).toBe(true);

    store.modelManagerHfQuery.set('qwen');
    fixture.detectChanges();
    expect(section(el, 'downloaded-list')?.open).toBe(true);
    expect(section(el, 'featured-list')?.open).toBe(true);

    await userToggle(fixture, section(el, 'featured-list')!, false);
    expect(section(el, 'featured-list')?.open).toBe(false);

    store.modelManagerHfQuery.set('');
    fixture.detectChanges();
    expect(section(el, 'downloaded-list')?.open).toBe(false);
    expect(section(el, 'featured-list')?.open).toBe(false);
    fixture.destroy();
  });

  it('open to show a selection made elsewhere, without undoing a later close', async () => {
    const { store, fixture } = setup();
    const el = await render(fixture);
    store.modelManagerSelection.set({ kind: 'hf', id: FEATURED_HF_MODELS[0]!.id });
    await render(fixture);
    expect(section(el, 'featured-list')?.open).toBe(true);
    await userToggle(fixture, section(el, 'featured-list')!, false);
    await render(fixture);
    expect(section(el, 'featured-list')?.open).toBe(false);
    fixture.destroy();
  });

  it('stay open for a row picked during a search once the search ends', async () => {
    const { store, fixture } = setup();
    const el = await render(fixture);
    store.modelManagerHfQuery.set('qwen');
    await render(fixture);
    store.modelManagerSelection.set({ kind: 'hf', id: FEATURED_HF_MODELS.find((m) => /qwen/i.test(m.id))!.id });
    await render(fixture);
    store.modelManagerHfQuery.set('');
    await render(fixture);
    expect(section(el, 'featured-list')?.open).toBe(true);
    fixture.destroy();
  });

  it('leave collapsed rows out of arrow-key movement', async () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const { store, fixture } = setup();
    store.modelManagerCustomModels.set([LOCAL]);
    const el = await render(fixture);
    const select = vi.spyOn(store, 'selectHfModel').mockImplementation((id) => store.modelManagerSelection.set({ kind: 'hf', id }));
    const selectLocal = vi.spyOn(store, 'selectLocalModel');
    const press = (): void => {
      el.querySelector('.mm-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    };
    press();
    expect(select).not.toHaveBeenCalled();
    expect(selectLocal).not.toHaveBeenCalled();

    await userToggle(fixture, section(el, 'featured-list')!, true);
    press();
    expect(selectLocal).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledOnce();
    await Promise.resolve();
    fixture.destroy();
    vi.unstubAllGlobals();
  });
});

describe('featured tutorial targets', () => {
  it('renders a labelled group per size, smallest first, and only for groups with a visible row', async () => {
    const { store, fixture } = setup();
    const el = await render(fixture);
    const keys = (name: string): (string | null)[] =>
      [...el.querySelectorAll('[data-tutorial="' + name + '"] .mm-row')].map((row) => row.getAttribute('data-row-key'));
    expect(keys('featured-low')).toEqual(['hf:unsloth/Qwen3.5-9B-GGUF', 'hf:unsloth/gemma-4-12b-it-GGUF']);
    expect(keys('featured-medium')).toEqual(['hf:unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF']);
    expect(keys('featured-big')).toEqual(['hf:unsloth/Qwen3.8-27B-GGUF']);
    expect(keys('featured-moe')).toEqual([
      'hf:ggml-org/gpt-oss-20b-GGUF', 'hf:unsloth/gemma-4-26B-A4B-it-GGUF',
      'hf:unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'hf:unsloth/Qwen3.6-35B-A3B-GGUF',
    ]);
    expect([...el.querySelectorAll('.mm-list__group')].map((heading) => heading.textContent?.trim().split(' ')[0])).toEqual(['Small', 'Medium', 'Large', 'MoE']);
    expect(el.querySelector('[data-tutorial="featured-moe"]')?.textContent).not.toContain('whole model still has to fit');
    expect(store.modelManagerSelection()).toBeNull();

    store.modelManagerHfQuery.set('gemma');
    fixture.detectChanges();
    expect(keys('featured-low')).toEqual(['hf:unsloth/gemma-4-12b-it-GGUF']);
    expect(keys('featured-moe')).toEqual(['hf:unsloth/gemma-4-26B-A4B-it-GGUF']);
    expect(el.querySelector('[data-tutorial="featured-medium"]')).toBeNull();
    expect(el.querySelector('[data-tutorial="featured-big"]')).toBeNull();
    expect(store.modelManagerSelection()).toBeNull();
    fixture.destroy();
  });

  it('only selects a visible Low preview on the preview event and never starts a download', () => {
    const { store, fixture } = setup();
    fixture.detectChanges();
    const select = vi.spyOn(store, 'selectHfModel').mockImplementation((id) => store.modelManagerSelection.set({ kind: 'hf', id }));
    const download = vi.spyOn(store, 'downloadHfQuant');
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-low' } }));
    expect(select).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-preview' } }));
    expect(select).toHaveBeenCalledExactlyOnceWith(smallestSmallModel(FEATURED_HF_MODELS)?.id);
    window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'featured-models', stepId: 'featured-preview' } }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
