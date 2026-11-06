import { Component, DestroyRef, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  LSP_SERVER_CATALOG,
  normalizePathList,
  type GdscriptDiagnosticsProfile,
  type GdscriptLspSettings,
  type PythonDiagnosticMode,
  type PythonLspSettings,
  type PythonProjectConfigInfo,
  type PythonTypeCheckingMode,
} from '@shared/lsp-settings';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-lsp',
  imports: [FormsModule, PillSelectComponent],
  templateUrl: './settings-lsp.html',
  styleUrl: './settings-lsp.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsLsp {
  protected readonly s = inject(SettingsStore);
  private readonly electron = inject(ElectronService);

  protected readonly server = computed(
    () => LSP_SERVER_CATALOG.find((entry) => entry.id === this.s.activeSubTabId('lsp')) ?? LSP_SERVER_CATALOG[0]!,
  );
  protected readonly godot = computed(() => this.s.lspServers().gdscript);
  /** The Dependencies row behind the Godot server, once the list has loaded. */
  protected readonly gdls = computed(() => this.s.lspDependencies().find((dep) => dep.id === 'gdls') ?? null);

  protected readonly profileOptions: ReadonlyArray<{ id: GdscriptDiagnosticsProfile; label: string }> = [
    { id: 'godot', label: "Godot (matches the editor's warnings)" },
    { id: 'strict', label: 'Strict (more warnings)' },
    { id: 'off', label: 'Off' },
  ];

  protected readonly python = computed(() => this.s.lspServers().python);
  /** The open workspace's own basedpyright config, which wins over some of the settings here. */
  protected readonly pythonProjectConfig = signal<PythonProjectConfigInfo | null>(null);
  /**
   * The Extra paths box as typed. The saved list is normalized (trimmed, no blank or repeated
   * lines), so the box can't show it directly: a space or a line that repeats an earlier one
   * would vanish mid-typing.
   */
  protected readonly extraPathsDraft = signal('');

  protected readonly typeCheckingOptions: ReadonlyArray<{ id: PythonTypeCheckingMode; label: string }> = [
    { id: 'off', label: 'Off' },
    { id: 'basic', label: 'Basic' },
    { id: 'standard', label: 'Standard' },
    { id: 'strict', label: 'Strict' },
    { id: 'recommended', label: 'Recommended (basedpyright)' },
    { id: 'all', label: 'All rules' },
  ];

  protected readonly diagnosticModeOptions: ReadonlyArray<{ id: PythonDiagnosticMode; label: string }> = [
    { id: 'openFilesOnly', label: 'Open files only' },
    { id: 'workspace', label: 'Whole workspace' },
  ];

  constructor() {
    void this.s.refreshLspDependencies();
    // Dependencies is its own window, and a project's config files can change while Settings is
    // open: check again when the user comes back.
    const refresh = (): void => {
      void this.s.refreshLspDependencies();
      if (this.server().id === 'python') {
        void this.refreshPythonProjectConfig();
      }
    };
    window.addEventListener('focus', refresh);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('focus', refresh));
    effect(() => {
      if (this.server().id === 'python') {
        void this.refreshPythonProjectConfig();
      }
    });
    // Show the saved list when it changes from outside the box (settings loaded or discarded).
    effect(() => {
      const saved = this.python().extraPaths;
      untracked(() => {
        if (!samePaths(parseExtraPaths(this.extraPathsDraft()), saved)) {
          this.extraPathsDraft.set(saved.join('\n'));
        }
      });
    });
  }

  protected patch(patch: Partial<GdscriptLspSettings>): void {
    this.s.patchGdscriptLsp(patch);
  }

  protected patchPython(patch: Partial<PythonLspSettings>): void {
    this.s.patchPythonLsp(patch);
  }

  /** One path per line; blank and repeated lines are dropped. */
  protected setExtraPaths(text: string): void {
    this.extraPathsDraft.set(text);
    const extraPaths = parseExtraPaths(text);
    if (!samePaths(extraPaths, this.python().extraPaths)) {
      this.patchPython({ extraPaths });
    }
  }

  private async refreshPythonProjectConfig(): Promise<void> {
    const res = await this.electron.lspPythonProjectConfig();
    this.pythonProjectConfig.set(res.ok ? res.config : null);
  }

  protected async browseForGodot(): Promise<void> {
    const picked = await this.electron.openFileDialog();
    if (picked) {
      this.patch({ godotBinaryPath: picked });
    }
  }

  protected openDependencies(): void {
    this.electron.openDependenciesWindow();
  }
}

function parseExtraPaths(text: string): string[] {
  return normalizePathList(text.split(/\r?\n/));
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}
