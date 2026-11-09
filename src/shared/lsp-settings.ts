/** Settings → LSP: the integrated language servers and the options saved for them. */

import type { DependencyId } from './types/dependencies';

export type GdscriptDiagnosticsProfile = 'godot' | 'strict' | 'off';

export interface GdscriptLspSettings {
  /** Godot executable for the engine API dump; empty lets gdls look for one. */
  godotBinaryPath: string;
  /**
   * Lets gdls run Godot on a project to read its native add-on classes. That can load the project's
   * native code, so it stays off until someone turns it on.
   */
  allowEngineApiDump: boolean;
  diagnosticsProfile: GdscriptDiagnosticsProfile;
  inlayTypeHints: boolean;
  inlayParameterHints: boolean;
  /** Formatter executable; empty uses ``gdformat`` when it is on ``PATH``. */
  formatterCommand: string;
  /** Formatter arguments, separated by spaces. */
  formatterArgs: string;
}

/** basedpyright's ``typeCheckingMode`` values, loosest first. */
export const PYTHON_TYPE_CHECKING_MODES = ['off', 'basic', 'standard', 'strict', 'recommended', 'all'] as const;
export type PythonTypeCheckingMode = (typeof PYTHON_TYPE_CHECKING_MODES)[number];

export type PythonDiagnosticMode = 'openFilesOnly' | 'workspace';

export interface PythonLspSettings {
  /** A project ``pyrightconfig.json`` or ``[tool.basedpyright]`` / ``[tool.pyright]`` section wins over this. */
  typeCheckingMode: PythonTypeCheckingMode;
  diagnosticMode: PythonDiagnosticMode;
  inlayVariableTypes: boolean;
  inlayCallArgumentNames: boolean;
  inlayFunctionReturnTypes: boolean;
  inlayGenericTypes: boolean;
  autoImportCompletions: boolean;
  /** Extra import roots; relative ones resolve against the workspace folder. */
  extraPaths: string[];
}

export const TYPESCRIPT_PARAMETER_NAME_HINTS = ['none', 'literals', 'all'] as const;
export type TypescriptParameterNameHints = (typeof TYPESCRIPT_PARAMETER_NAME_HINTS)[number];

export const TYPESCRIPT_IMPORT_MODULE_SPECIFIERS = ['shortest', 'relative', 'non-relative', 'project-relative'] as const;
export type TypescriptImportModuleSpecifier = (typeof TYPESCRIPT_IMPORT_MODULE_SPECIFIERS)[number];

export const TYPESCRIPT_QUOTE_STYLES = ['auto', 'single', 'double'] as const;
export type TypescriptQuoteStyle = (typeof TYPESCRIPT_QUOTE_STYLES)[number];

/** vtsls, for TypeScript and JavaScript alike. Defaults are vtsls' (VS Code's) own. */
export interface TypescriptLspSettings {
  /** Use the workspace's ``node_modules/typescript`` instead of the TypeScript vtsls ships with. */
  useWorkspaceTsdk: boolean;
  /** Report errors in JavaScript files (``javascript.validate.enable``). */
  validateJavaScript: boolean;
  /** Type-check JavaScript files that no ``jsconfig.json`` / ``tsconfig.json`` covers. */
  checkJs: boolean;
  inlayParameterNames: TypescriptParameterNameHints;
  inlayParameterTypes: boolean;
  inlayVariableTypes: boolean;
  inlayPropertyDeclarationTypes: boolean;
  inlayFunctionReturnTypes: boolean;
  inlayEnumMemberValues: boolean;
  autoImportCompletions: boolean;
  importModuleSpecifier: TypescriptImportModuleSpecifier;
  quoteStyle: TypescriptQuoteStyle;
}

export const JAVA_MAX_HEAP_SIZES = ['512M', '1G', '2G', '4G', '8G'] as const;
export type JavaMaxHeapSize = (typeof JAVA_MAX_HEAP_SIZES)[number];

/** ``interactive`` is left out: it asks through a prompt that only the VS Code extension shows. */
export const JAVA_UPDATE_BUILD_CONFIGURATIONS = ['automatic', 'disabled'] as const;
export type JavaUpdateBuildConfiguration = (typeof JAVA_UPDATE_BUILD_CONFIGURATIONS)[number];

export const JAVA_PARAMETER_NAME_HINTS = ['none', 'literals', 'all'] as const;
export type JavaParameterNameHints = (typeof JAVA_PARAMETER_NAME_HINTS)[number];

export const JAVA_IMPLEMENTATION_CODE_LENS = ['none', 'types', 'methods', 'all'] as const;
export type JavaImplementationCodeLens = (typeof JAVA_IMPLEMENTATION_CODE_LENS)[number];

export const JAVA_GUESS_METHOD_ARGUMENTS = ['off', 'insertParameterNames', 'insertBestGuessedArguments'] as const;
export type JavaGuessMethodArguments = (typeof JAVA_GUESS_METHOD_ARGUMENTS)[number];

/** A JDK projects can compile against. */
export interface JavaRuntime {
  /** Execution environment, e.g. ``JavaSE-17`` or ``JavaSE-1.8``. */
  name: string;
  /** JDK folder. */
  path: string;
}

/** Eclipse JDT LS. Defaults keep what Clara ran before these settings existed, except signature help, which is on. */
export interface JavaLspSettings {
  /** JDK that runs JDT LS; empty looks at ``JAVA_HOME``, then ``java`` on ``PATH``. */
  jdkHome: string;
  maxHeap: JavaMaxHeapSize;
  /** The first is the default for folders with no build file. A folder's ``.clara/java.json`` wins over these. */
  runtimes: JavaRuntime[];
  importMaven: boolean;
  importGradle: boolean;
  /** Write ``.project``, ``.classpath`` and ``.settings`` into the project; off keeps them in JDT LS's own data. */
  projectMetadataAtRoot: boolean;
  /** Maven ``settings.xml``; empty uses Maven's own lookup. */
  mavenUserSettings: string;
  updateBuildConfiguration: JavaUpdateBuildConfiguration;
  autobuild: boolean;
  inlayParameterNames: JavaParameterNameHints;
  inlayVariableTypes: boolean;
  inlayParameterTypes: boolean;
  inlayFormatParameters: boolean;
  referencesCodeLens: boolean;
  implementationCodeLens: JavaImplementationCodeLens;
  signatureHelp: boolean;
  guessMethodArguments: JavaGuessMethodArguments;
  formatEnabled: boolean;
  formatOnType: boolean;
  formatComments: boolean;
  /** Eclipse formatter profile XML; empty uses JDT LS's built-in style. */
  formatterSettingsPath: string;
  /** Profile to use from that file; empty uses its first. */
  formatterProfile: string;
}

export interface LspServersSettings {
  gdscript: GdscriptLspSettings;
  python: PythonLspSettings;
  typescript: TypescriptLspSettings;
  java: JavaLspSettings;
}

export function defaultLspServersSettings(): LspServersSettings {
  return {
    gdscript: {
      godotBinaryPath: '',
      allowEngineApiDump: false,
      diagnosticsProfile: 'godot',
      inlayTypeHints: true,
      inlayParameterHints: true,
      formatterCommand: '',
      formatterArgs: '',
    },
    python: {
      typeCheckingMode: 'standard',
      diagnosticMode: 'openFilesOnly',
      // basedpyright's own inlay hint defaults.
      inlayVariableTypes: true,
      inlayCallArgumentNames: true,
      inlayFunctionReturnTypes: true,
      inlayGenericTypes: false,
      autoImportCompletions: true,
      extraPaths: [],
    },
    typescript: {
      useWorkspaceTsdk: false,
      validateJavaScript: true,
      checkJs: false,
      inlayParameterNames: 'none',
      inlayParameterTypes: false,
      inlayVariableTypes: false,
      inlayPropertyDeclarationTypes: false,
      inlayFunctionReturnTypes: false,
      inlayEnumMemberValues: false,
      autoImportCompletions: true,
      importModuleSpecifier: 'shortest',
      quoteStyle: 'auto',
    },
    java: {
      jdkHome: '',
      maxHeap: '1G',
      runtimes: [],
      importMaven: true,
      importGradle: true,
      projectMetadataAtRoot: true,
      mavenUserSettings: '',
      updateBuildConfiguration: 'automatic',
      autobuild: true,
      // JDT LS's own defaults from here down, except signature help, which it leaves off.
      inlayParameterNames: 'literals',
      inlayVariableTypes: false,
      inlayParameterTypes: false,
      inlayFormatParameters: false,
      referencesCodeLens: true,
      implementationCodeLens: 'none',
      signatureHelp: true,
      guessMethodArguments: 'insertParameterNames',
      formatEnabled: true,
      formatOnType: false,
      formatComments: true,
      formatterSettingsPath: '',
      formatterProfile: '',
    },
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function objectOr(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Trimmed, non-empty, de-duplicated path strings; anything else is dropped. */
export function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const path = typeof item === 'string' ? item.trim() : '';
    if (path && !out.includes(path)) {
      out.push(path);
    }
  }
  return out;
}

function normalizePythonLspSettings(raw: unknown): PythonLspSettings {
  const defaults = defaultLspServersSettings().python;
  const p = objectOr(raw) as Partial<Record<keyof PythonLspSettings, unknown>>;
  const mode = p.typeCheckingMode;
  return {
    typeCheckingMode: PYTHON_TYPE_CHECKING_MODES.includes(mode as PythonTypeCheckingMode)
      ? (mode as PythonTypeCheckingMode)
      : defaults.typeCheckingMode,
    diagnosticMode:
      p.diagnosticMode === 'openFilesOnly' || p.diagnosticMode === 'workspace'
        ? p.diagnosticMode
        : defaults.diagnosticMode,
    inlayVariableTypes: booleanOr(p.inlayVariableTypes, defaults.inlayVariableTypes),
    inlayCallArgumentNames: booleanOr(p.inlayCallArgumentNames, defaults.inlayCallArgumentNames),
    inlayFunctionReturnTypes: booleanOr(p.inlayFunctionReturnTypes, defaults.inlayFunctionReturnTypes),
    inlayGenericTypes: booleanOr(p.inlayGenericTypes, defaults.inlayGenericTypes),
    autoImportCompletions: booleanOr(p.autoImportCompletions, defaults.autoImportCompletions),
    extraPaths: normalizePathList(p.extraPaths),
  };
}

function normalizeTypescriptLspSettings(raw: unknown): TypescriptLspSettings {
  const defaults = defaultLspServersSettings().typescript;
  const t = objectOr(raw) as Partial<Record<keyof TypescriptLspSettings, unknown>>;
  return {
    useWorkspaceTsdk: booleanOr(t.useWorkspaceTsdk, defaults.useWorkspaceTsdk),
    validateJavaScript: booleanOr(t.validateJavaScript, defaults.validateJavaScript),
    checkJs: booleanOr(t.checkJs, defaults.checkJs),
    inlayParameterNames: oneOf(t.inlayParameterNames, TYPESCRIPT_PARAMETER_NAME_HINTS, defaults.inlayParameterNames),
    inlayParameterTypes: booleanOr(t.inlayParameterTypes, defaults.inlayParameterTypes),
    inlayVariableTypes: booleanOr(t.inlayVariableTypes, defaults.inlayVariableTypes),
    inlayPropertyDeclarationTypes: booleanOr(t.inlayPropertyDeclarationTypes, defaults.inlayPropertyDeclarationTypes),
    inlayFunctionReturnTypes: booleanOr(t.inlayFunctionReturnTypes, defaults.inlayFunctionReturnTypes),
    inlayEnumMemberValues: booleanOr(t.inlayEnumMemberValues, defaults.inlayEnumMemberValues),
    autoImportCompletions: booleanOr(t.autoImportCompletions, defaults.autoImportCompletions),
    importModuleSpecifier: oneOf(
      t.importModuleSpecifier,
      TYPESCRIPT_IMPORT_MODULE_SPECIFIERS,
      defaults.importModuleSpecifier,
    ),
    quoteStyle: oneOf(t.quoteStyle, TYPESCRIPT_QUOTE_STYLES, defaults.quoteStyle),
  };
}

/** Trimmed, complete entries; a repeated execution environment keeps its first JDK. */
export function normalizeJavaRuntimes(value: unknown): JavaRuntime[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: JavaRuntime[] = [];
  for (const item of value) {
    const entry = objectOr(item);
    const name = stringOr(entry['name'], '').trim();
    const path = stringOr(entry['path'], '').trim();
    if (name && path && !out.some((runtime) => runtime.name === name)) {
      out.push({ name, path });
    }
  }
  return out;
}

/** The Project JDKs box: one ``name=folder`` per line. A folder can hold ``=``; a name can't. */
export function parseJavaRuntimes(text: string): JavaRuntime[] {
  return normalizeJavaRuntimes(
    text.split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=');
      return separator < 0 ? {} : { name: line.slice(0, separator), path: line.slice(separator + 1) };
    }),
  );
}

export function formatJavaRuntimes(runtimes: readonly JavaRuntime[]): string {
  return runtimes.map((runtime) => `${runtime.name}=${runtime.path}`).join('\n');
}

function normalizeJavaLspSettings(raw: unknown): JavaLspSettings {
  const defaults = defaultLspServersSettings().java;
  const j = objectOr(raw) as Partial<Record<keyof JavaLspSettings, unknown>>;
  return {
    jdkHome: stringOr(j.jdkHome, defaults.jdkHome),
    maxHeap: oneOf(j.maxHeap, JAVA_MAX_HEAP_SIZES, defaults.maxHeap),
    runtimes: normalizeJavaRuntimes(j.runtimes),
    importMaven: booleanOr(j.importMaven, defaults.importMaven),
    importGradle: booleanOr(j.importGradle, defaults.importGradle),
    projectMetadataAtRoot: booleanOr(j.projectMetadataAtRoot, defaults.projectMetadataAtRoot),
    mavenUserSettings: stringOr(j.mavenUserSettings, defaults.mavenUserSettings),
    updateBuildConfiguration: oneOf(
      j.updateBuildConfiguration,
      JAVA_UPDATE_BUILD_CONFIGURATIONS,
      defaults.updateBuildConfiguration,
    ),
    autobuild: booleanOr(j.autobuild, defaults.autobuild),
    inlayParameterNames: oneOf(j.inlayParameterNames, JAVA_PARAMETER_NAME_HINTS, defaults.inlayParameterNames),
    inlayVariableTypes: booleanOr(j.inlayVariableTypes, defaults.inlayVariableTypes),
    inlayParameterTypes: booleanOr(j.inlayParameterTypes, defaults.inlayParameterTypes),
    inlayFormatParameters: booleanOr(j.inlayFormatParameters, defaults.inlayFormatParameters),
    referencesCodeLens: booleanOr(j.referencesCodeLens, defaults.referencesCodeLens),
    implementationCodeLens: oneOf(
      j.implementationCodeLens,
      JAVA_IMPLEMENTATION_CODE_LENS,
      defaults.implementationCodeLens,
    ),
    signatureHelp: booleanOr(j.signatureHelp, defaults.signatureHelp),
    guessMethodArguments: oneOf(j.guessMethodArguments, JAVA_GUESS_METHOD_ARGUMENTS, defaults.guessMethodArguments),
    formatEnabled: booleanOr(j.formatEnabled, defaults.formatEnabled),
    formatOnType: booleanOr(j.formatOnType, defaults.formatOnType),
    formatComments: booleanOr(j.formatComments, defaults.formatComments),
    formatterSettingsPath: stringOr(j.formatterSettingsPath, defaults.formatterSettingsPath),
    formatterProfile: stringOr(j.formatterProfile, defaults.formatterProfile),
  };
}

/** Fills missing or malformed fields with defaults, so a hand-edited config can't break the tab. */
export function normalizeLspServersSettings(raw: unknown): LspServersSettings {
  const defaults = defaultLspServersSettings().gdscript;
  const root = objectOr(raw);
  const g = objectOr(root['gdscript']) as Partial<Record<keyof GdscriptLspSettings, unknown>>;
  const profile = g.diagnosticsProfile;
  return {
    gdscript: {
      godotBinaryPath: stringOr(g.godotBinaryPath, defaults.godotBinaryPath),
      // Only an explicit true opts in: this one lets a project's native code run.
      allowEngineApiDump: g.allowEngineApiDump === true,
      diagnosticsProfile:
        profile === 'godot' || profile === 'strict' || profile === 'off' ? profile : defaults.diagnosticsProfile,
      inlayTypeHints: booleanOr(g.inlayTypeHints, defaults.inlayTypeHints),
      inlayParameterHints: booleanOr(g.inlayParameterHints, defaults.inlayParameterHints),
      formatterCommand: stringOr(g.formatterCommand, defaults.formatterCommand),
      formatterArgs: stringOr(g.formatterArgs, defaults.formatterArgs),
    },
    python: normalizePythonLspSettings(root['python']),
    typescript: normalizeTypescriptLspSettings(root['typescript']),
    java: normalizeJavaLspSettings(root['java']),
  };
}

export interface LspServerCatalogEntry {
  /** Stable server id (``lsp-registry``), also the Settings sub-tab id. */
  id: 'gdscript' | 'python' | 'typescript' | 'java';
  label: string;
  /** The language server behind it. */
  server: string;
  languages: string;
  /** The Dependencies entry that installs it; null when it ships with Clara. */
  dependencyId: DependencyId | null;
}

/** Every integrated language server, in the order the LSP tab lists them. */
export const LSP_SERVER_CATALOG: readonly LspServerCatalogEntry[] = [
  {
    id: 'gdscript',
    label: 'Godot',
    server: 'gdls',
    languages: 'GDScript (.gd)',
    dependencyId: 'gdls',
  },
  {
    id: 'python',
    label: 'Python',
    server: 'basedpyright',
    languages: 'Python (.py)',
    dependencyId: null,
  },
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    server: 'vtsls',
    languages: 'TypeScript and JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs)',
    dependencyId: null,
  },
  {
    id: 'java',
    label: 'Java',
    server: 'Eclipse JDT LS',
    languages: 'Java (.java)',
    dependencyId: 'java-lsp',
  },
];

/** Where a workspace's own basedpyright config lives, if it has one. */
export interface PythonProjectConfigInfo {
  /** Workspace-relative file, e.g. ``pyrightconfig.json`` or ``pyproject.toml``. */
  file: string;
  /** The ``pyproject.toml`` table that holds it; empty for ``pyrightconfig.json``. */
  section: string;
}

/**
 * Finds the ``[tool.basedpyright]`` or ``[tool.pyright]`` table basedpyright reads from a
 * ``pyproject.toml``. Its own sub-tables (``[tool.pyright.foo]``) count too. Returns '' when there is none.
 */
export function pyprojectPyrightSection(text: string): string {
  const match = /^[ 	]*\[[ 	]*tool\.(basedpyright|pyright)[ 	]*[\].]/m.exec(text);
  return match ? `tool.${match[1]}` : '';
}
