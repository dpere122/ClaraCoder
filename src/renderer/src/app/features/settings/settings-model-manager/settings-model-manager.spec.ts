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
