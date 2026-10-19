/**
 * Theme engine shared surface: document schema + validation, token catalog, generated group
 * registry, CSS scoping, Monaco derivation, and the bundled built-in themes.
 * No Node / DOM imports — safe for Electron main, preload, and the renderer.
 */
export type {
  ClaraThemeDocument,
  ThemeBackgroundFit,
  ThemeGroupBackground,
  ThemeGroupOverride,
  ThemeMode,
  ThemeMonacoBase,
  ThemeMonacoDefinition,
  ThemeMonacoRule,
  ThemeValidationIssue,
  ThemeValidationResult,
  ValidateThemeOptions,
} from './theme-document';
export {
  THEME_ASSET_DATA_URL_PATTERN,
  THEME_ASSET_NAME_PATTERN,
  THEME_BACKGROUND_FITS,
  THEME_DOCUMENT_VERSION,
  THEME_ID_PATTERN,
  THEME_MODES,
  THEME_MONACO_BASES,
  THEME_NAME_MAX_CHARS,
  THEME_TOKEN_VALUE_MAX_CHARS,
  cloneThemeDocument,
  defaultMonacoBaseForMode,
  emptyThemeDocument,
  isHexColor,
  isSafeThemeTokenValue,
  isThemeAssetDataUrl,
  looksLikeCssColor,
  missingThemeTokens,
  normalizeBareHex,
  normalizeMonacoHex,
  slugifyThemeId,
  themeBackgroundGroupIds,
  validateThemeDocument,
} from './theme-document';
export type { ThemeTokenCategory, ThemeTokenCategoryId, ThemeTokenDef, ThemeTokenKind } from './theme-tokens';
export {
  THEME_RUNTIME_ONLY_PROPERTIES,
  THEME_TOKENS,
  THEME_TOKEN_CATEGORIES,
  THEME_TOKEN_NAMES,
  isThemeTokenName,
  themeTokenDef,
  themeTokensInCategory,
} from './theme-tokens';
export type { ThemeGroupCategoryDef, ThemeGroupDef } from './theme-registry-types';
export {
  THEME_GROUP_ID_PATTERN,
  humanizeThemeSegment,
  isValidThemeGroupId,
  themeGroupSelector,
} from './theme-registry-types';
export type { ThemeGroupId } from './theme-registry.generated';
export {
  THEME_GROUPS,
  THEME_GROUP_CATEGORIES,
  THEME_GROUP_IDS,
  isThemeGroupId,
  themeGroupDef,
  themeGroupsInCategory,
} from './theme-registry.generated';
export type { ThemeCssScopeResult } from './theme-css-scope';
export {
  THEME_GROUP_CSS_MAX_CHARS,
  isAllowedThemeCssUrl,
  scopeThemeCss,
  scopeThemeSelector,
  splitCssTopLevel,
  stripCssComments,
} from './theme-css-scope';
export type { DeriveMonacoThemeOptions, ThemeColorResolver } from './theme-monaco';
export {
  MONACO_APP_THEME_NAME,
  MONACO_COLOR_TOKEN_MAP,
  MONACO_RULE_TOKEN_MAP,
  MONACO_THEME_GROUP_ID,
  cssColorToHex,
  deriveMonacoTheme,
  hexWithAlpha,
  resolveThemeTokenColor,
} from './theme-monaco';
export {
  BUILTIN_THEMES,
  BUILTIN_THEME_IDS,
  CLARA_DARK_THEME,
  CLARA_LIGHT_THEME,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  LEGACY_THEME_ID_MAP,
  builtInThemeForMode,
  findBuiltInTheme,
  isBuiltInThemeId,
  resolveLegacyThemeId,
} from './builtin';
export type { ResolvedTheme, ResolvedThemeBackground, ResolvedThemeGroup, ThemeAssetUrlResolver } from './theme-resolve';
export type {
  ThemeAssetPickResult,
  ThemeExportResult,
  ThemeImportResult,
  ThemeMutationResult,
  ThemeSaveResult,
} from './theme-ipc';
export { THEME_IPC } from './theme-ipc';
export { cssQuote, resolveThemeDocument, themeStylesheetText } from './theme-resolve';
