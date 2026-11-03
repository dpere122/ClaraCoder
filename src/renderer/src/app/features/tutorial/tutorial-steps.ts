import type { TutorialCursor, TutorialWindow } from '@shared/types/tutorial';

/** Presentation only: the shared registry owns the durable order and IDs. */
export interface TutorialStepDescriptor extends TutorialCursor {
  readonly window: TutorialWindow;
  readonly title: string;
  readonly body: string;
  /** Ordered alternatives; use stable data-tutorial values, not CSS layout selectors. */
  readonly targets?: readonly string[];
  readonly unavailableHint?: string;
  readonly nextLabel?: string;
  readonly wiki?: boolean;
  readonly celebration?: boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStepDescriptor[] = [
  {
    phaseId: 'intro', stepId: 'welcome', window: 'home',
    title: 'Welcome to Clara Coder',
    body: 'Clara Coder is an Agentic Integrated Development Environment: an IDE with an assistant that can explore and work on your project. Let’s look around, then explore an optional local model setup. Your workspace stays as it is.',
  },
  {
    phaseId: 'intro', stepId: 'home-start', window: 'home',
    title: 'Start here',
    body: 'Home brings together workspaces, Sources, Model Manager, and Dependencies. With a workspace open, the top-bar menus keep these actions available.',
    targets: ['home-start', 'home-navigation'],
  },
  {
    phaseId: 'intro', stepId: 'home-workspace', window: 'home',
    title: 'Your workspace',
    body: 'A workspace is a project folder. Clara can read and search its files and build a semantic index, respecting ignore rules by default. Choosing a folder can switch workspaces; this tour never changes yours.',
    targets: ['home-add-workspace', 'home-file-menu'],
  },
  {
    phaseId: 'intro', stepId: 'home-navigation', window: 'home',
    title: 'Model sources',
    body: 'Sources connect Clara to a provider and a model, such as a cloud API, LM Studio, or a managed local llama.cpp server. The Sources action is here; we’ll return to it later.',
    targets: ['home-sources', 'home-settings-menu'],
    unavailableHint: 'Use the Settings menu to find Sources, or continue the tour.',
  },
  {
    phaseId: 'intro', stepId: 'home-models', window: 'home',
    title: 'Your model library',
    body: 'Model Manager browses Hugging Face repositories and saves the GGUF files you choose to your local model library. We’ll explore its featured models after looking at the local engine.',
    targets: ['home-model-manager', 'home-settings-menu'],
    unavailableHint: 'Use the Settings menu to find Model Manager, or continue the tour.',
  },
  {
    phaseId: 'intro', stepId: 'home-dependencies', window: 'home',
    title: 'Optional local engine',
    body: 'Clara’s managed local llama.cpp sources require llama-server, which Dependencies can install. Cloud APIs and separately run servers do not need Clara’s download.',
    targets: ['home-dependencies', 'home-dependencies-menu'],
    unavailableHint: 'The Dependencies action is not visible here. You can still open it with the button below.',
    nextLabel: 'Open Dependencies',
  },
  {
    phaseId: 'local-engine', stepId: 'engine-intro', window: 'dependencies',
    title: 'Meet llama-server',
    body: 'llama-server is the runtime Clara starts for a managed local llama.cpp source. That setup requires llama-server; remote or separately hosted sources can be used without installing it here.',
    targets: ['dependencies-llama'],
    unavailableHint: 'Dependencies may still be loading, or another install may be using the focused view. Retry, continue, or skip this phase.',
  },
  {
    phaseId: 'local-engine', stepId: 'engine-install', window: 'dependencies',
    title: 'Install if you want to',
    body: 'When llama-server is missing, use Download. Retry repeats the last action, including a reinstall if that is what failed. The tour starts nothing; you may continue without installing.',
    targets: ['dependencies-llama-install', 'dependencies-llama-progress', 'dependencies-llama'],
    unavailableHint: 'The install control is not currently visible. Check the Dependencies window, retry, or continue without installing.',
    nextLabel: 'Continue to Home',
  },
  {
    phaseId: 'featured-models', stepId: 'home-model-manager', window: 'home',
    title: 'Explore models',
    body: 'Model Manager lists local files and featured Hugging Face models. Open it from Home or Settings; the tour will not download a model.',
    targets: ['home-model-manager', 'home-settings-menu'],
    unavailableHint: 'The Home action is not visible with this layout. Use the button below to open Model Manager.',
    nextLabel: 'Open Model Manager',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-intro', window: 'settings',
    title: 'Featured models',
    body: 'Featured links to curated Hugging Face GGUF repositories; browsing metadata uses the network. Check your RAM, GPU memory and disk space: a featured model is not guaranteed to fit your hardware.',
    targets: ['featured-list'],
    unavailableHint: 'Open Model Manager and clear its search to show the Featured list, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-small', window: 'settings',
    title: 'A smaller example',
    body: 'Small models generally need fewer resources, but “Small” is relative to this list and does not guarantee a model will fit or run well on your machine. Check the file size and available memory.',
    targets: ['featured-small'],
    unavailableHint: 'The Small example is hidden or unavailable. Clear the Model Manager search, retry, or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-largest', window: 'settings',
    title: 'Compare a larger model',
    body: 'This row has the highest total parameter count among the currently visible Featured models; a filter may leave only one. Mixture-of-experts models activate only part per token, but total weights still affect storage and memory.',
    targets: ['featured-largest'],
    unavailableHint: 'The largest visible example is unavailable. Clear the Model Manager search, retry, or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-preview', window: 'settings',
    title: 'Preview model details',
    body: 'The provider identifies the base model’s creator when available. If nothing is selected, the tour may request metadata for the visible Small example; existing selections are kept. No model is downloaded.',
    targets: ['featured-provider'],
    unavailableHint: 'Select a featured model to view its provider. Metadata may be loading or unavailable; retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-uploader', window: 'settings',
    title: 'Meet the uploader',
    body: 'The uploader publishes this GGUF on Hugging Face and may differ from the model’s creator. Check both the source and license before downloading.',
    targets: ['featured-uploader'],
    unavailableHint: 'Select a featured model to view its uploader. Metadata may be loading or unavailable; retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-quantizations', window: 'settings',
    title: 'Quantizations',
    body: 'GGUF is a model-file format. Quantized variants generally trade precision for lower storage and memory needs, sometimes reducing quality. Compare file sizes and compatibility; downloading is always your decision.',
    targets: ['featured-quantizations'],
    unavailableHint: 'Select a Hugging Face model to see files. The list may be loading, empty, or unavailable; retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-navigation', window: 'settings',
    title: 'Open Sources',
    body: 'Choose Sources in Settings to configure where chat models come from. Settings changes are a draft until you click Apply.',
    targets: ['settings-sources-nav'],
    unavailableHint: 'Find Sources in the Settings navigation, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-add', window: 'settings',
    title: 'Add a source',
    body: 'The plus button adds a managed llama.cpp source as an unapplied draft; it does not activate it for chat. You can keep using another source. The tour creates nothing for you.',
    targets: ['sources-add'],
    unavailableHint: 'Open Sources to find Add source, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-model', window: 'settings',
    title: 'Choose a local model',
    body: 'The Local model picker lists downloaded GGUFs and Hub folders. A sample Hugging Face ID is not a downloaded model. Add a model in Model Manager if needed; the tour will not choose one.',
    targets: ['sources-local-model'],
    unavailableHint: 'Select or add a managed llama.cpp source first. If no model is downloaded, you can continue without choosing one.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-defaults', window: 'settings',
    title: 'Model defaults',
    body: 'Some model creators recommend specific inference settings. Ready defaults offers inference templates; review more settings under Advanced → Inference near the bottom. Changes remain a draft until Apply.',
    targets: ['sources-defaults'],
    unavailableHint: 'Select a managed llama.cpp source to see its defaults, or continue without changing them.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-advanced', window: 'settings',
    title: 'Advanced options',
    body: 'Advanced includes llama-server launch flags and inference settings. Consult the upstream llama.cpp wiki below before changing unfamiliar options.',
    targets: ['sources-advanced'],
    unavailableHint: 'Select a managed llama.cpp source to see its advanced options, or continue without changing them.',
    wiki: true,
  },
  {
    phaseId: 'local-source', stepId: 'sources-apply', window: 'settings',
    title: 'Apply your changes',
    body: 'Apply saves all unsaved Settings changes, not just this source, so review your draft first. This tour will never apply or discard it for you.',
    targets: ['settings-apply'],
    unavailableHint: 'Apply is shown when there are unsaved Settings changes. No changes are required for this tour; retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'celebration', window: 'settings',
    title: 'You’re ready to explore',
    body: 'That’s the tour! Your workspace and any unapplied Settings draft are still yours. You can set up a local model later or use a remote source.',
    nextLabel: 'Finish',
    celebration: true,
  },
];

export function tutorialStepFor(cursor: TutorialCursor | null | undefined): TutorialStepDescriptor | null {
  return cursor ? TUTORIAL_STEPS.find((step) => step.phaseId === cursor.phaseId && step.stepId === cursor.stepId) ?? null : null;
}
