/**
 * Which integrated workspace LSP applies to a path — driven by
 * {@link ./lsp-registry}.
 */
export type { LspServerKind } from './lsp-registry';
export {
  LSP_EXTENSION_TO_SERVER,
  LSP_MONACO_LANGUAGE_IDS,
  LSP_SEMANTIC_LEGEND_PREFETCH_SERVER_IDS,
  LSP_SEMANTIC_LEGEND_SERVER_IDS,
  lspServerIdForMonacoLanguageId,
  lspServerKindForWorkspaceRelativePath,
} from './lsp-registry';
