import { Component, DestroyRef, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  LSP_SERVER_CATALOG,
  formatJavaRuntimes,
  javaRuntimeLineProblems,
  normalizePathList,
  parseJavaRuntimes,
  type GdscriptDiagnosticsProfile,
  type GdscriptLspSettings,
  type JavaGuessMethodArguments,
  type JavaImplementationCodeLens,
  type JavaLspSettings,
  type JavaMaxHeapSize,
  type JavaRuntime,
  type JavaUpdateBuildConfiguration,
  type PythonDiagnosticMode,
  type PythonLspSettings,
  type PythonProjectConfigInfo,
  type PythonTypeCheckingMode,
  type TypescriptImportModuleSpecifier,
  type TypescriptLspSettings,
  type TypescriptParameterNameHints,
  type TypescriptQuoteStyle,
} from '@shared/lsp-settings';
import type { DependencyInfo } from '@shared/types/dependencies';
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

  protected readonly typescript = computed(() => this.s.lspServers().typescript);

  protected readonly parameterNameHintOptions: ReadonlyArray<{ id: TypescriptParameterNameHints; label: string }> = [
    { id: 'none', label: 'Off' },
    { id: 'literals', label: 'Literal arguments only' },
    { id: 'all', label: 'All arguments' },
  ];

  protected readonly importSpecifierOptions: ReadonlyArray<{ id: TypescriptImportModuleSpecifier; label: string }> = [
    { id: 'shortest', label: 'Shortest' },
    { id: 'relative', label: 'Relative (./utils)' },
    { id: 'non-relative', label: 'Non-relative (paths / baseUrl)' },
    { id: 'project-relative', label: 'Relative within a project' },
  ];

  protected readonly quoteStyleOptions: ReadonlyArray<{ id: TypescriptQuoteStyle; label: string }> = [
    { id: 'auto', label: 'Match the file' },
    { id: 'single', label: 'Single' },
    { id: 'double', label: 'Double' },
  ];

  protected readonly java = computed(() => this.s.lspServers().java);
  /** The Dependencies row behind the Java server, once the list has loaded. */
  protected readonly jdtls = computed(() => this.s.lspDependencies().find((dep) => dep.id === 'java-lsp') ?? null);
  /** The Project JDKs box as typed, kept apart from the saved list for the same reason as Extra paths. */
  protected readonly javaRuntimesDraft = signal('');
  protected readonly javaRuntimeProblems = computed(() => javaRuntimeLineProblems(this.javaRuntimesDraft()));
  /** The last folder check, keyed by the folders checked so a stale answer is never shown. */
  private readonly jdkCheck = signal<{ jdkHome: string; jdkHomeMissing: string | null; runtimes: Map<string, string | null> } | null>(
    null,
  );
  private jdkCheckSeq = 0;
  /** JDK folder isn't a JDK: the backend refuses to start the server on it. */
  protected readonly jdkHomeProblem = computed(() => {
    const check = this.jdkCheck();
    const missing = check && check.jdkHome === this.java().jdkHome ? check.jdkHomeMissing : null;
    return missing ? `No Java executable at ${missing}. The Java server won't start until this is fixed.` : '';
  });
  /** Project JDKs that aren't JDKs, which also stop the server from starting. */
  protected readonly projectJdkProblems = computed(() => {
    const check = this.jdkCheck();
    if (!check) {
      return [];
    }
    return this.java().runtimes.flatMap((runtime) => {
      const missing = check.runtimes.get(runtime.path);
      return missing ? [`${runtime.name}: no Java executable at ${missing}. The Java server won't start until this is fixed.`] : [];
    });
  });

  protected readonly maxHeapOptions: ReadonlyArray<{ id: JavaMaxHeapSize; label: string }> = [
    { id: '512M', label: '512 MB' },
    { id: '1G', label: '1 GB' },
    { id: '2G', label: '2 GB' },
    { id: '4G', label: '4 GB' },
    { id: '8G', label: '8 GB' },
  ];

  protected readonly updateBuildOptions: ReadonlyArray<{ id: JavaUpdateBuildConfiguration; label: string }> = [
    { id: 'automatic', label: 'Automatically' },
    { id: 'disabled', label: 'Never' },
  ];

  protected readonly implementationLensOptions: ReadonlyArray<{ id: JavaImplementationCodeLens; label: string }> = [
    { id: 'none', label: 'Off' },
    { id: 'types', label: 'Types' },
    { id: 'methods', label: 'Methods' },
    { id: 'all', label: 'Types and methods' },
  ];

  protected readonly guessArgumentOptions: ReadonlyArray<{ id: JavaGuessMethodArguments; label: string }> = [
    { id: 'off', label: 'Leave empty' },
    { id: 'insertParameterNames', label: 'Parameter names' },
    { id: 'insertBestGuessedArguments', label: 'Best guess from variables in scope' },
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
      if (this.server().id === 'java') {
        void this.checkJdks();
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
    // Check the folders a moment after typing stops, not on every keystroke.
    effect((onCleanup) => {
      if (this.server().id !== 'java') {
        return;
      }
      const { jdkHome, runtimes } = this.java();
      const timer = setTimeout(() => void this.checkJdks(jdkHome, runtimes), JDK_CHECK_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => {
      const saved = this.java().runtimes;
      untracked(() => {
        if (!sameRuntimes(parseJavaRuntimes(this.javaRuntimesDraft()), saved)) {
          this.javaRuntimesDraft.set(formatJavaRuntimes(saved));
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

  protected patchTypescript(patch: Partial<TypescriptLspSettings>): void {
    this.s.patchTypescriptLsp(patch);
  }

  /** A Dependencies row's state in a sentence; an install that's updating or failed isn't "not installed". */
  protected dependencyStatus(dep: DependencyInfo): string {
    switch (dep.state) {
      case 'installed':
        return dep.version ? `Installed, ${dep.version}` : 'Installed';
      case 'updating':
        return 'Updating';
      case 'error':
        return 'Install problem, see Dependencies';
      default:
        return 'Not installed';
    }
  }

  protected patchJava(patch: Partial<JavaLspSettings>): void {
    this.s.patchJavaLsp(patch);
  }

  /** One ``name=folder`` per line; lines that aren't complete yet are left out of the saved list. */
  protected setJavaRuntimes(text: string): void {
    this.javaRuntimesDraft.set(text);
    const runtimes = parseJavaRuntimes(text);
    if (!sameRuntimes(runtimes, this.java().runtimes)) {
      this.patchJava({ runtimes });
    }
  }

  protected async browseForJdk(): Promise<void> {
    const picked = await this.electron.openDirectoryDialog();
    if (picked) {
      this.patchJava({ jdkHome: picked });
    }
  }

  protected async browseForXml(field: 'mavenUserSettings' | 'formatterSettingsPath'): Promise<void> {
    const picked = await this.electron.openFileDialog({ filters: [{ name: 'XML files', extensions: ['xml'] }] });
    if (picked) {
      this.patchJava({ [field]: picked });
    }
  }

  /** One path per line; blank and repeated lines are dropped. */
  protected setExtraPaths(text: string): void {
    this.extraPathsDraft.set(text);
    const extraPaths = parseExtraPaths(text);
    if (!samePaths(extraPaths, this.python().extraPaths)) {
      this.patchPython({ extraPaths });
    }
  }

  private async checkJdks(jdkHome = this.java().jdkHome, runtimes = this.java().runtimes): Promise<void> {
    const seq = ++this.jdkCheckSeq;
    const paths = runtimes.map((runtime) => runtime.path);
    const res = await this.electron.lspJavaCheckJdks(jdkHome, paths);
    if (seq !== this.jdkCheckSeq || !res.ok) {
      return;
    }
    this.jdkCheck.set({
      jdkHome,
      jdkHomeMissing: res.check.jdkHome,
      runtimes: new Map(paths.map((path, index) => [path, res.check.runtimes[index] ?? null])),
    });
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

const JDK_CHECK_DELAY_MS = 300;

function parseExtraPaths(text: string): string[] {
  return normalizePathList(text.split(/\r?\n/));
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

function sameRuntimes(a: readonly JavaRuntime[], b: readonly JavaRuntime[]): boolean {
  return a.length === b.length && a.every((runtime, index) => runtime.name === b[index]?.name && runtime.path === b[index]?.path);
}
