import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLspServersSettings,
  type LspServersSettings,
  type PythonLspSettings,
  type TypescriptLspSettings,
} from '@shared/lsp-settings';
import { ElectronService } from '../../../core/electron.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsLsp } from './settings-lsp';

function setup(subTab = 'python') {
  const lspServers = signal<LspServersSettings>(defaultLspServersSettings());
  const store = {
    lspServers,
    lspDependencies: () => [],
    activeSubTabId: () => subTab,
    refreshLspDependencies: vi.fn().mockResolvedValue(undefined),
    patchGdscriptLsp: vi.fn(),
    patchPythonLsp: vi.fn((patch: Partial<PythonLspSettings>) => {
      lspServers.update((servers) => ({ ...servers, python: { ...servers.python, ...patch } }));
    }),
    patchTypescriptLsp: vi.fn((patch: Partial<TypescriptLspSettings>) => {
      lspServers.update((servers) => ({ ...servers, typescript: { ...servers.typescript, ...patch } }));
    }),
  };
  const electron = {
    lspPythonProjectConfig: vi.fn().mockResolvedValue({ ok: true, workspacePath: '', config: null }),
    openFileDialog: vi.fn(),
    openDependenciesWindow: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [SettingsLsp],
    providers: [
      { provide: SettingsStore, useValue: store },
      { provide: ElectronService, useValue: electron },
    ],
  });
  const fixture = TestBed.createComponent(SettingsLsp);
  return { fixture, store, lspServers };
}

async function settle(fixture: ReturnType<typeof setup>['fixture']): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function textarea(fixture: ReturnType<typeof setup>['fixture']): HTMLTextAreaElement {
  return (fixture.nativeElement as HTMLElement).querySelector('textarea')!;
}

async function type(fixture: ReturnType<typeof setup>['fixture'], value: string): Promise<void> {
  const box = textarea(fixture);
  box.value = value;
  box.dispatchEvent(new Event('input'));
  await settle(fixture);
}

beforeEach(() => TestBed.resetTestingModule());

describe('Python Extra paths box', () => {
  it('keeps what the user is typing while saving the cleaned-up list', async () => {
    const { fixture, lspServers } = setup();
    await settle(fixture);

    // A space inside a folder name, then a second line that starts like the first.
    for (const value of ['my', 'my ', 'my d', 'my dir\nm', 'my dir\nmy', 'my dir\nmy dir', 'my dir\nmy dir2']) {
      await type(fixture, value);
      expect(textarea(fixture).value).toBe(value);
    }
    expect(lspServers().python.extraPaths).toEqual(['my dir', 'my dir2']);
  });

  it('does not mark settings dirty for edits that leave the list unchanged', async () => {
    const { fixture, store } = setup();
    await settle(fixture);
    await type(fixture, 'src');
    store.patchPythonLsp.mockClear();

    await type(fixture, 'src\n');
    await type(fixture, 'src \n\n');

    expect(store.patchPythonLsp).not.toHaveBeenCalled();
  });

  it('shows the saved list when it changes from outside the box', async () => {
    const { fixture, lspServers } = setup();
    await settle(fixture);
    await type(fixture, 'draft');

    lspServers.update((servers) => ({ ...servers, python: { ...servers.python, extraPaths: ['src', 'libs'] } }));
    await settle(fixture);

    expect(textarea(fixture).value).toBe('src\nlibs');
  });
});

describe('TypeScript / JavaScript settings', () => {
  function checkbox(fixture: ReturnType<typeof setup>['fixture'], label: string): HTMLInputElement {
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('label.toggle-row')];
    const row = rows.find((el) => el.textContent?.includes(label));
    expect(row, label).toBeTruthy();
    return row!.querySelector('input')!;
  }

  it('shows the saved values and saves a toggle', async () => {
    const { fixture, store, lspServers } = setup('typescript');
    lspServers.update((servers) => ({ ...servers, typescript: { ...servers.typescript, checkJs: true } }));
    await settle(fixture);

    expect(checkbox(fixture, 'Type-check JavaScript files').checked).toBe(true);
    expect(checkbox(fixture, 'Report errors in JavaScript files').checked).toBe(true);
    expect(checkbox(fixture, 'Show inferred variable types').checked).toBe(false);

    const variableTypes = checkbox(fixture, 'Show inferred variable types');
    variableTypes.click();
    await settle(fixture);

    expect(store.patchTypescriptLsp).toHaveBeenCalledWith({ inlayVariableTypes: true });
    expect(lspServers().typescript.inlayVariableTypes).toBe(true);
    expect(store.patchPythonLsp).not.toHaveBeenCalled();
  });

  it('disables JavaScript type-checking while JavaScript errors are off', async () => {
    const { fixture, lspServers } = setup('typescript');
    await settle(fixture);
    expect(checkbox(fixture, 'Type-check JavaScript files').disabled).toBe(false);

    lspServers.update((servers) => ({ ...servers, typescript: { ...servers.typescript, validateJavaScript: false } }));
    await settle(fixture);
    expect(checkbox(fixture, 'Type-check JavaScript files').disabled).toBe(true);
  });

  it("doesn't show the Python form", async () => {
    const { fixture } = setup('typescript');
    await settle(fixture);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('vtsls');
    expect(text).not.toContain('basedpyright');
    expect((fixture.nativeElement as HTMLElement).querySelector('textarea')).toBeNull();
  });
});
