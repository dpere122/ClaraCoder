import { describe, expect, it } from 'vitest';
import { LSP_MONACO_LANGUAGE_IDS, LSP_SEMANTIC_LEGEND_SERVER_IDS } from './lsp-registry';
import {
  LSP_SERVER_CATALOG,
  PYTHON_TYPE_CHECKING_MODES,
  TYPESCRIPT_IMPORT_MODULE_SPECIFIERS,
  TYPESCRIPT_PARAMETER_NAME_HINTS,
  TYPESCRIPT_QUOTE_STYLES,
  defaultLspServersSettings,
  normalizeLspServersSettings,
  normalizePathList,
  pyprojectPyrightSection,
} from './lsp-settings';

describe('normalizeLspServersSettings', () => {
  it.each([undefined, null, 'x', 3, {}, { gdscript: 'x' }])('fills defaults for %j', (raw) => {
    expect(normalizeLspServersSettings(raw)).toEqual(defaultLspServersSettings());
  });

  it('keeps valid values', () => {
    const saved = {
      gdscript: {
        godotBinaryPath: 'C:/godot/godot.exe',
        allowEngineApiDump: true,
        diagnosticsProfile: 'strict',
        inlayTypeHints: false,
        inlayParameterHints: false,
        formatterCommand: 'fmt',
        formatterArgs: '--stdin',
      },
    };
    const defaults = defaultLspServersSettings();
    expect(normalizeLspServersSettings(saved)).toEqual({
      ...saved,
      python: defaults.python,
      typescript: defaults.typescript,
    });
  });

  it('replaces a bad field and keeps the rest', () => {
    const { gdscript } = normalizeLspServersSettings({
      gdscript: { godotBinaryPath: 'godot', diagnosticsProfile: 'loud', inlayTypeHints: 'no' },
    });
    expect(gdscript.godotBinaryPath).toBe('godot');
    expect(gdscript.diagnosticsProfile).toBe('godot');
    expect(gdscript.inlayTypeHints).toBe(true);
  });

  it.each([undefined, 'true', 1, {}])('never treats %j as permission to run Godot', (value) => {
    expect(normalizeLspServersSettings({ gdscript: { allowEngineApiDump: value } }).gdscript.allowEngineApiDump).toBe(
      false,
    );
  });

  it('is off by default', () => {
    expect(defaultLspServersSettings().gdscript.allowEngineApiDump).toBe(false);
  });
});

describe('LSP_SERVER_CATALOG', () => {
  it('lists every integrated server', () => {
    expect(LSP_SERVER_CATALOG.map((server) => server.id).sort()).toEqual([...LSP_SEMANTIC_LEGEND_SERVER_IDS].sort());
    expect(LSP_MONACO_LANGUAGE_IDS.length).toBeGreaterThan(0);
  });

  it('makes Godot, Python and TypeScript editable', () => {
    expect(LSP_SERVER_CATALOG.filter((server) => server.editable).map((server) => server.id)).toEqual([
      'gdscript',
      'python',
      'typescript',
    ]);
  });
});

describe('normalizeLspServersSettings (python)', () => {
  it('keeps valid values', () => {
    const python = {
      typeCheckingMode: 'recommended',
      diagnosticMode: 'workspace',
      inlayVariableTypes: false,
      inlayCallArgumentNames: false,
      inlayFunctionReturnTypes: false,
      inlayGenericTypes: true,
      autoImportCompletions: false,
      extraPaths: ['src', 'libs/vendored'],
    };
    expect(normalizeLspServersSettings({ python }).python).toEqual(python);
  });

  it('replaces bad fields and keeps the rest', () => {
    const { python } = normalizeLspServersSettings({
      python: { typeCheckingMode: 'loud', diagnosticMode: 'everything', inlayGenericTypes: 'yes', autoImportCompletions: false },
    });
    expect(python.typeCheckingMode).toBe('standard');
    expect(python.diagnosticMode).toBe('openFilesOnly');
    expect(python.inlayGenericTypes).toBe(false);
    expect(python.autoImportCompletions).toBe(false);
  });

  it.each(PYTHON_TYPE_CHECKING_MODES)('accepts type checking mode %s', (mode) => {
    expect(normalizeLspServersSettings({ python: { typeCheckingMode: mode } }).python.typeCheckingMode).toBe(mode);
  });

  it('cleans extra paths', () => {
    expect(
      normalizeLspServersSettings({ python: { extraPaths: [' src ', '', 3, null, 'src', 'libs'] } }).python.extraPaths,
    ).toEqual(['src', 'libs']);
    expect(normalizeLspServersSettings({ python: { extraPaths: 'src' } }).python.extraPaths).toEqual([]);
  });

  it('keeps Godot settings when only Python is saved', () => {
    expect(normalizeLspServersSettings({ python: {} }).gdscript).toEqual(defaultLspServersSettings().gdscript);
  });
});

describe('normalizePathList', () => {
  it.each([undefined, null, 'src', {}, 3])('returns [] for %j', (value) => {
    expect(normalizePathList(value)).toEqual([]);
  });
});

describe('pyprojectPyrightSection', () => {
  it('finds [tool.basedpyright] and [tool.pyright]', () => {
    expect(pyprojectPyrightSection('[project]\nname = "x"\n\n[tool.basedpyright]\ntypeCheckingMode = "all"\n')).toBe(
      'tool.basedpyright',
    );
    expect(pyprojectPyrightSection('[tool.pyright]\n')).toBe('tool.pyright');
    expect(pyprojectPyrightSection('  [ tool.pyright ]  # comment\n')).toBe('tool.pyright');
  });

  it('counts a sub-table', () => {
    expect(pyprojectPyrightSection('[tool.pyright.defineConstant]\nDEBUG = true\n')).toBe('tool.pyright');
  });

  it('ignores other tools and mentions outside a table header', () => {
    expect(pyprojectPyrightSection('[tool.ruff]\nline-length = 100\n')).toBe('');
    expect(pyprojectPyrightSection('[tool.pyrightish]\n')).toBe('');
    expect(pyprojectPyrightSection('# see [tool.pyright] docs\n')).toBe('');
    expect(pyprojectPyrightSection('description = "uses [tool.pyright]"\n')).toBe('');
    expect(pyprojectPyrightSection('[[tool.pyright]]\n')).toBe('');
  });
});

describe('normalizeLspServersSettings (typescript)', () => {
  it('keeps valid values', () => {
    const typescript = {
      useWorkspaceTsdk: true,
      validateJavaScript: false,
      checkJs: true,
      inlayParameterNames: 'literals',
      inlayParameterTypes: true,
      inlayVariableTypes: true,
      inlayPropertyDeclarationTypes: true,
      inlayFunctionReturnTypes: true,
      inlayEnumMemberValues: true,
      autoImportCompletions: false,
      importModuleSpecifier: 'non-relative',
      quoteStyle: 'single',
    };
    expect(normalizeLspServersSettings({ typescript }).typescript).toEqual(typescript);
  });

  it('replaces a bad field and keeps the rest', () => {
    const { typescript } = normalizeLspServersSettings({
      typescript: { inlayParameterNames: 'some', importModuleSpecifier: 'absolute', quoteStyle: 'backtick', checkJs: 'yes', inlayVariableTypes: true },
    });
    const defaults = defaultLspServersSettings().typescript;
    expect(typescript.inlayParameterNames).toBe(defaults.inlayParameterNames);
    expect(typescript.importModuleSpecifier).toBe(defaults.importModuleSpecifier);
    expect(typescript.quoteStyle).toBe(defaults.quoteStyle);
    expect(typescript.checkJs).toBe(false);
    expect(typescript.inlayVariableTypes).toBe(true);
  });

  it('accepts every option value', () => {
    for (const value of TYPESCRIPT_PARAMETER_NAME_HINTS) {
      expect(normalizeLspServersSettings({ typescript: { inlayParameterNames: value } }).typescript.inlayParameterNames).toBe(value);
    }
    for (const value of TYPESCRIPT_IMPORT_MODULE_SPECIFIERS) {
      expect(normalizeLspServersSettings({ typescript: { importModuleSpecifier: value } }).typescript.importModuleSpecifier).toBe(value);
    }
    for (const value of TYPESCRIPT_QUOTE_STYLES) {
      expect(normalizeLspServersSettings({ typescript: { quoteStyle: value } }).typescript.quoteStyle).toBe(value);
    }
  });

  it("defaults to vtsls' own settings, so nothing changes until someone edits them", () => {
    expect(defaultLspServersSettings().typescript).toEqual({
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
    });
  });
});
