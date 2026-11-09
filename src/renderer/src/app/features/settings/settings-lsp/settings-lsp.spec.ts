import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLspServersSettings,
  type JavaLspSettings,
  type LspServersSettings,
  type PythonLspSettings,
  type TypescriptLspSettings,
} from '@shared/lsp-settings';
import type { DependencyInfo } from '@shared/types/dependencies';
import { ElectronService } from '../../../core/electron.service';
import { SettingsStore } from '../settings/settings-store';
import { SettingsLsp } from './settings-lsp';

function setup(subTab = 'python') {
  const lspServers = signal<LspServersSettings>(defaultLspServersSettings());
  const deps = signal<DependencyInfo[]>([]);
  const store = {
    lspServers,
    lspDependencies: deps,
    activeSubTabId: () => subTab,
    refreshLspDependencies: vi.fn().mockResolvedValue(undefined),
    patchGdscriptLsp: vi.fn(),
    patchPythonLsp: vi.fn((patch: Partial<PythonLspSettings>) => {
      lspServers.update((servers) => ({ ...servers, python: { ...servers.python, ...patch } }));
    }),
    patchTypescriptLsp: vi.fn((patch: Partial<TypescriptLspSettings>) => {
      lspServers.update((servers) => ({ ...servers, typescript: { ...servers.typescript, ...patch } }));
    }),
    patchJavaLsp: vi.fn((patch: Partial<JavaLspSettings>) => {
      lspServers.update((servers) => ({ ...servers, java: { ...servers.java, ...patch } }));
    }),
  };
  const electron = {
    lspPythonProjectConfig: vi.fn().mockResolvedValue({ ok: true, workspacePath: '', config: null }),
    openFileDialog: vi.fn(),
    openDirectoryDialog: vi.fn(),
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
  return { fixture, store, electron, lspServers, deps };
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

describe('Java settings', () => {
  function checkbox(fixture: ReturnType<typeof setup>['fixture'], label: string): HTMLInputElement {
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('label.toggle-row')];
    const row = rows.find((el) => el.textContent?.includes(label));
    expect(row, label).toBeTruthy();
    return row!.querySelector('input')!;
  }

  it('shows the form instead of the placeholder, and saves a toggle', async () => {
    const { fixture, store, lspServers } = setup('java');
    await settle(fixture);

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Eclipse JDT LS');
    expect(text).not.toContain("aren't available yet");
    expect(checkbox(fixture, 'Import Maven projects').checked).toBe(true);
    expect(checkbox(fixture, 'Show the method signature').checked).toBe(true);

    checkbox(fixture, 'Show the method signature').click();
    await settle(fixture);

    expect(store.patchJavaLsp).toHaveBeenCalledWith({ signatureHelp: false });
    expect(lspServers().java.signatureHelp).toBe(false);
    expect(store.patchTypescriptLsp).not.toHaveBeenCalled();
  });

  it('saves where imported projects keep their project files', async () => {
    const { fixture, store, lspServers } = setup('java');
    await settle(fixture);
    const toggle = checkbox(fixture, 'Keep project files in the project folder');
    expect(toggle.checked).toBe(true);

    toggle.click();
    await settle(fixture);

    expect(store.patchJavaLsp).toHaveBeenCalledWith({ projectMetadataAtRoot: false });
    expect(lspServers().java.projectMetadataAtRoot).toBe(false);
  });

  it('disables the comment and on-type options while formatting is off', async () => {
    const { fixture, lspServers } = setup('java');
    await settle(fixture);
    expect(checkbox(fixture, 'Format comments too').disabled).toBe(false);

    lspServers.update((servers) => ({ ...servers, java: { ...servers.java, formatEnabled: false } }));
    await settle(fixture);
    expect(checkbox(fixture, 'Format comments too').disabled).toBe(true);
    expect(checkbox(fixture, 'Allow formatting while typing').disabled).toBe(true);
  });

  it('keeps a half-typed Project JDKs line while saving the complete ones', async () => {
    const { fixture, store, lspServers } = setup('java');
    await settle(fixture);

    for (const value of ['JavaSE', 'JavaSE-17=', 'JavaSE-17=C:\\my jdk', 'JavaSE-17=C:\\my jdk\nJavaSE-2']) {
      await type(fixture, value);
      expect(textarea(fixture).value).toBe(value);
    }
    expect(lspServers().java.runtimes).toEqual([{ name: 'JavaSE-17', path: 'C:\\my jdk' }]);

    store.patchJavaLsp.mockClear();
    await type(fixture, 'JavaSE-17=C:\\my jdk\nJavaSE-21');
    expect(store.patchJavaLsp).not.toHaveBeenCalled();
  });

  it('points out Project JDKs lines that do nothing, and only those', async () => {
    const { fixture } = setup('java');
    await settle(fixture);
    const warnings = (): string[] =>
      [...(fixture.nativeElement as HTMLElement).querySelectorAll('.settings-field-hint--warning')].map(
        (hint) => hint.textContent ?? '',
      );
    expect(warnings()).toEqual([]);

    await type(fixture, 'JavaSE-17=C:\\jdk-17');
    expect(warnings()).toEqual([]);

    await type(fixture, 'JavaSE-17=C:\\jdk-17\n17=C:\\jdk-17\nJavaSE-21');
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain('Line 2: 17');
    expect(warnings()[1]).toContain("Line 3 isn't saved");
  });

  it('says what a dependency is doing rather than calling every other state not installed', async () => {
    const { fixture, deps } = setup('java');
    const status = async (dep: Partial<DependencyInfo>): Promise<string> => {
      deps.set([{ id: 'java-lsp', version: null, path: null, ...dep } as DependencyInfo]);
      await settle(fixture);
      return (fixture.nativeElement as HTMLElement).querySelector('.settings-lsp-status .panel__copy')?.textContent?.trim() ?? '';
    };

    expect(await status({ state: 'installed', version: '1.60.0' })).toBe('Eclipse JDT LS · Installed, 1.60.0');
    expect(await status({ state: 'installed' })).toBe('Eclipse JDT LS · Installed');
    expect(await status({ state: 'updating' })).toBe('Eclipse JDT LS · Updating');
    expect(await status({ state: 'error' })).toBe('Eclipse JDT LS · Install problem, see Dependencies');
    expect(await status({ state: 'missing' })).toBe('Eclipse JDT LS · Not installed');
  });

  it('shows the saved Project JDKs when they change from outside the box', async () => {
    const { fixture, lspServers } = setup('java');
    await settle(fixture);
    await type(fixture, 'draft');

    lspServers.update((servers) => ({
      ...servers,
      java: { ...servers.java, runtimes: [{ name: 'JavaSE-17', path: 'C:/jdk-17' }] },
    }));
    await settle(fixture);

    expect(textarea(fixture).value).toBe('JavaSE-17=C:/jdk-17');
  });

  it('browses for a JDK folder and for XML files, and ignores a cancelled picker', async () => {
    const { fixture, electron, lspServers } = setup('java');
    await settle(fixture);
    const browse = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Browse…',
    );
    expect(browse).toHaveLength(3);

    electron.openDirectoryDialog.mockResolvedValueOnce(null);
    browse[0]!.click();
    await settle(fixture);
    expect(lspServers().java.jdkHome).toBe('');

    electron.openDirectoryDialog.mockResolvedValueOnce('C:\\jdk-21');
    browse[0]!.click();
    await settle(fixture);
    expect(lspServers().java.jdkHome).toBe('C:\\jdk-21');

    electron.openFileDialog.mockResolvedValueOnce('C:\\m2\\settings.xml');
    browse[1]!.click();
    await settle(fixture);
    expect(lspServers().java.mavenUserSettings).toBe('C:\\m2\\settings.xml');

    electron.openFileDialog.mockResolvedValueOnce('C:\\style.xml');
    browse[2]!.click();
    await settle(fixture);
    expect(lspServers().java.formatterSettingsPath).toBe('C:\\style.xml');
    expect(electron.openFileDialog).toHaveBeenCalledWith({ filters: [{ name: 'XML files', extensions: ['xml'] }] });
  });
});
