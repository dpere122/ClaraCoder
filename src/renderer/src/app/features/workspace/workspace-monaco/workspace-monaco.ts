import {
  afterNextRender,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type * as Monaco from 'monaco-editor';
import type { MonacoWorkspaceEditorSettings, WorkspaceFilesChangedMessage } from '@shared/index';
import { normalizeMonacoWorkspaceEditorSettings } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import { monacoWorkspaceSettingsToEditorOptions } from './workspace-monaco-editor-options';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  vue: 'html',
  svelte: 'html',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
};

@Component({
  selector: 'app-workspace-monaco',
  standalone: true,
  templateUrl: './workspace-monaco.html',
  styleUrl: './workspace-monaco.css',
})
export class WorkspaceMonacoComponent {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  /** Absolute workspace root (empty when none). */
  readonly workspacePath = input<string>('');
  /** Active file as POSIX relative path, or null when the conversation tab is selected. */
  readonly relativePath = input<string | null>(null);
  /** Relative paths of all open file tabs; models for closed tabs are disposed. */
  readonly openFileRelativePaths = input<readonly string[]>([]);
  /** Persisted Monaco options from app config (optional until loaded). */
  readonly editorSettings = input<MonacoWorkspaceEditorSettings | null | undefined>(undefined);

  /** Relative paths whose buffer differs from the last disk-synced version (unsaved). */
  readonly unsavedPathsChange = output<readonly string[]>();

  protected readonly loadError = signal('');

  private readonly editorHost = viewChild.required<ElementRef<HTMLElement>>('editorHost');

  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private readonly editorReady = signal(false);
  /** After app theme switches, Monaco can keep stale font/layout metrics (broken mouse hit-testing); refresh when `:root` tokens change. */
  private uiThemeObserver: MutationObserver | null = null;
  private themeRefreshRaf: number | null = null;
  private readonly modelByPath = new Map<string, Monaco.editor.ITextModel>();
  /** `getAlternativeVersionId()` after last load from disk or successful save; used to skip reload when the buffer is dirty. */
  private readonly diskSyncedAltVersionByPath = new Map<string, number>();
  private readonly modelDirtyDisposables = new Map<string, Monaco.IDisposable>();

  constructor() {
    afterNextRender(() => void this.bootstrapEditor());

    effect(() => {
      const open = [...this.openFileRelativePaths()];
      if (!this.monaco) {
        return;
      }
      untracked(() => {
        for (const [key, model] of this.modelByPath) {
          if (!open.includes(key)) {
            if (this.editor?.getModel() === model) {
              this.editor.setModel(null);
            }
            this.modelDirtyDisposables.get(key)?.dispose();
            this.modelDirtyDisposables.delete(key);
            model.dispose();
            this.modelByPath.delete(key);
            this.diskSyncedAltVersionByPath.delete(key);
          }
        }
        this.emitDirtyPaths();
      });
    });

    effect(() => {
      const rel = this.relativePath();
      const root = this.workspacePath()?.trim();
      const ready = this.editorReady();
      if (!ready || !this.editor || !this.monaco) {
        return;
      }
      if (!rel?.trim() || !root) {
        untracked(() => this.loadError.set(''));
        return;
      }
      void untracked(() => this.syncActiveModel(root, rel.trim()));
    });

    effect(() => {
      const cfg = this.editorSettings();
      const ready = this.editorReady();
      const ed = this.editor;
      const monacoApi = this.monaco;
      if (!ready || !ed || !monacoApi) {
        return;
      }
      const { settings } = normalizeMonacoWorkspaceEditorSettings(cfg == null ? undefined : cfg);
      untracked(() => {
        ed.updateOptions(monacoWorkspaceSettingsToEditorOptions(settings));
        if (settings.theme === 'clara-monaco') {
          this.defineClaraTheme(monacoApi);
        }
        monacoApi.editor.setTheme(settings.theme);
      });
    });

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onWorkspaceFilesChanged(event));

    if (typeof MutationObserver !== 'undefined') {
      this.uiThemeObserver = new MutationObserver(() => this.scheduleMonacoRefreshAfterUiThemeChange());
      this.uiThemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-bs-theme'],
      });
    }

    this.destroyRef.onDestroy(() => {
      if (this.themeRefreshRaf != null) {
        cancelAnimationFrame(this.themeRefreshRaf);
        this.themeRefreshRaf = null;
      }
      this.uiThemeObserver?.disconnect();
      this.uiThemeObserver = null;
      for (const m of this.modelByPath.values()) {
        m.dispose();
      }
      this.modelByPath.clear();
      this.diskSyncedAltVersionByPath.clear();
      this.editor?.dispose();
      this.editor = null;
      this.monaco = null;
    });
  }

  private scheduleMonacoRefreshAfterUiThemeChange(): void {
    if (this.themeRefreshRaf != null) {
      cancelAnimationFrame(this.themeRefreshRaf);
    }
    this.themeRefreshRaf = requestAnimationFrame(() => {
      this.themeRefreshRaf = null;
      this.refreshMonacoAfterUiThemeChange();
      requestAnimationFrame(() => this.editor?.layout());
    });
  }

  /** Re-sync Monaco with updated CSS variables / layout after the shell theme changes. */
  private refreshMonacoAfterUiThemeChange(): void {
    const ed = this.editor;
    const monacoApi = this.monaco;
    if (!this.editorReady() || !ed || !monacoApi) {
      return;
    }
    const cfg = this.editorSettings();
    const { settings } = normalizeMonacoWorkspaceEditorSettings(cfg == null ? undefined : cfg);
    ed.updateOptions(monacoWorkspaceSettingsToEditorOptions(settings));
    if (settings.theme === 'clara-monaco') {
      this.defineClaraTheme(monacoApi);
    }
    monacoApi.editor.setTheme(settings.theme);
    ed.layout();
  }

  private workspaceRootsEqual(a: string, b: string): boolean {
    const x = normalizePathSlashes(a).replace(/\/+$/, '').toLowerCase();
    const y = normalizePathSlashes(b).replace(/\/+$/, '').toLowerCase();
    return x.length > 0 && x === y;
  }

  private onWorkspaceFilesChanged(event: WorkspaceFilesChangedMessage): void {
    const root = this.workspacePath()?.trim();
    if (!root || !this.workspaceRootsEqual(root, event.workspacePath)) {
      return;
    }

    const refreshAll = event.paths.some((p) => {
      const s = normalizePathSlashes(p.trim());
      return s === '.' || s === '';
    });

    const keys = new Set<string>();
    if (refreshAll) {
      for (const k of this.modelByPath.keys()) {
        keys.add(k);
      }
    } else {
      for (const p of event.paths) {
        if (p.startsWith('[staging] ')) {
          continue;
        }
        const k = normalizePathSlashes(p);
        if (this.modelByPath.has(k)) {
          keys.add(k);
        }
      }
    }

    for (const key of keys) {
      void this.reloadModelFromDiskIfUnmodified(key);
    }
  }

  private async reloadModelFromDiskIfUnmodified(relativeKey: string): Promise<void> {
    const monacoApi = this.monaco;
    const root = this.workspacePath()?.trim();
    const model = this.modelByPath.get(relativeKey);
    if (!monacoApi || !root || !model || model.isDisposed()) {
      return;
    }

    let baseline = this.diskSyncedAltVersionByPath.get(relativeKey);
    if (baseline === undefined) {
      baseline = model.getAlternativeVersionId();
      this.diskSyncedAltVersionByPath.set(relativeKey, baseline);
    }
    if (model.getAlternativeVersionId() !== baseline) {
      return;
    }

    const res = await this.electron.readWorkspaceFile(root, relativeKey);
    const activeKey = this.relativePath()?.trim() ? normalizePathSlashes(this.relativePath()!.trim()) : '';

    if (!res.ok || res.content === undefined) {
      if (relativeKey === activeKey) {
        this.loadError.set(res.error ?? 'File is no longer available.');
      }
      return;
    }

    this.loadError.set('');
    if (model.getValue() !== res.content) {
      model.setValue(res.content);
    }
    this.diskSyncedAltVersionByPath.set(relativeKey, model.getAlternativeVersionId());
    this.emitDirtyPaths();
  }

  private languageIdForPath(monacoApi: typeof Monaco, rel: string): string {
    const base = rel.split('/').pop() ?? rel;
    const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
    if (base.toLowerCase() === 'dockerfile') {
      return 'dockerfile';
    }
    const mapped = EXT_TO_LANG[ext];
    if (mapped) {
      return mapped;
    }
    const found = monacoApi.languages.getLanguages().find((l) => l.id === ext);
    return found?.id ?? 'plaintext';
  }

  private defineClaraTheme(monacoApi: typeof Monaco): void {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const bg = pick('--t-code-bg', '#1a1a1a');
    const fg = pick('--t-code-text', '#d4d4d4');
    const line = pick('--t-border-subtle', '#333333');
    const selection = pick('--t-selection-bg', '#264f78');
    monacoApi.editor.defineTheme('clara-monaco', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editorLineNumber.foreground': pick('--t-text-muted', '#858585'),
        'editor.lineHighlightBackground': pick('--t-hover-bg', '#ffffff0c'),
        'editorCursor.foreground': pick('--t-primary', '#00ff41'),
        'editor.selectionBackground': selection,
        'editor.inactiveSelectionBackground': selection + '99',
        'editorWhitespace.foreground': line,
        'editorIndentGuide.background': line,
        'editorIndentGuide.activeBackground': pick('--t-border', '#555'),
      },
    });
  }

  private async bootstrapEditor(): Promise<void> {
    const monacoApi = await import('monaco-editor');
    this.monaco = monacoApi;
    this.defineClaraTheme(monacoApi);
    const host = this.editorHost().nativeElement;
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() == null ? undefined : this.editorSettings()!);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);
    this.editor = monacoApi.editor.create(host, {
      ...mapped,
      theme: settings.theme,
      automaticLayout: true,
    });
    this.editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      void this.saveCurrent();
    });
    this.editorReady.set(true);
    this.emitDirtyPaths();
  }

  private ensureModelDirtyListener(key: string, model: Monaco.editor.ITextModel): void {
    this.modelDirtyDisposables.get(key)?.dispose();
    const d = model.onDidChangeContent(() => this.emitDirtyPaths());
    this.modelDirtyDisposables.set(key, d);
  }

  private emitDirtyPaths(): void {
    const list: string[] = [];
    for (const [key, model] of this.modelByPath) {
      if (model.isDisposed()) {
        continue;
      }
      const synced = this.diskSyncedAltVersionByPath.get(key);
      if (synced === undefined) {
        continue;
      }
      if (model.getAlternativeVersionId() !== synced) {
        list.push(key);
      }
    }
    list.sort();
    this.zone.run(() => this.unsavedPathsChange.emit(list));
  }

  private async syncActiveModel(workspaceRoot: string, relativePath: string): Promise<void> {
    const monacoApi = this.monaco;
    const ed = this.editor;
    if (!monacoApi || !ed) {
      return;
    }
    const key = normalizePathSlashes(relativePath);
    let model = this.modelByPath.get(key);
    if (!model) {
      this.loadError.set('');
      const res = await this.electron.readWorkspaceFile(workspaceRoot, key);
      if (!res.ok || res.content === undefined) {
        this.loadError.set(res.error ?? 'Failed to read file.');
        return;
      }
      const lang = this.languageIdForPath(monacoApi, key);
      const uri = monacoApi.Uri.parse(`clara-workspace:///${encodeURI(key)}`);
      model = monacoApi.editor.createModel(res.content, lang, uri);
      this.modelByPath.set(key, model);
      this.diskSyncedAltVersionByPath.set(key, model.getAlternativeVersionId());
    }
    this.ensureModelDirtyListener(key, model);
    this.loadError.set('');
    ed.setModel(model);
    ed.focus();
    this.emitDirtyPaths();
  }

  private async saveCurrent(): Promise<void> {
    const monacoApi = this.monaco;
    const ed = this.editor;
    const root = this.workspacePath()?.trim();
    const rel = this.relativePath()?.trim();
    if (!monacoApi || !ed || !root || !rel) {
      return;
    }
    const key = normalizePathSlashes(rel);
    const model = ed.getModel();
    if (!model || this.modelByPath.get(key) !== model) {
      return;
    }
    const content = model.getValue();
    const res = await this.electron.writeWorkspaceFile(root, key, content);
    if (!res.ok) {
      this.loadError.set(res.error ?? 'Save failed.');
      return;
    }
    this.diskSyncedAltVersionByPath.set(key, model.getAlternativeVersionId());
    this.loadError.set('');
    this.emitDirtyPaths();
  }
}
