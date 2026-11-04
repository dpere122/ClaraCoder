import type { TutorialCursor, TutorialWindow } from '@shared/types/tutorial';

/** Presentation only: the shared registry owns the durable order and IDs. */
export interface TutorialStepDescriptor extends TutorialCursor {
  readonly window: TutorialWindow;
  readonly title: string;
  /** Plain language for someone new to local models; technical terms belong in `details`. */
  readonly body: string;
  /** Shown collapsed under the body, for readers who want the technical picture. */
  readonly details?: string;
  /** Ordered alternatives; use stable data-tutorial values, not CSS layout selectors. */
  readonly targets?: readonly string[];
  readonly unavailableHint?: string;
  readonly nextLabel?: string;
  readonly wiki?: boolean;
  /** The tour's last step: shows a checkmark in place of the mascot and offers no skip links. */
  readonly complete?: boolean;
  /** Describes something only one screen shows, so advance past it instead of explaining an absent target. */
  readonly skipWhenAbsent?: boolean;
  /** data-tutorial name of a closed <details> the step's targets live in; opens on arrival. */
  readonly openDetails?: string;
  /** Bring the target into view on arrival, for steps far down a long page. */
  readonly scrollToTarget?: boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStepDescriptor[] = [
  {
    phaseId: 'intro', stepId: 'welcome', window: 'home',
    title: 'Welcome to Clara Coder',
    body: "Clara is an AI assistant that can explore your projects and work on them with you. Let's take a quick look around, then see how to run AI on your own computer.",
    details: 'Clara Coder is an Agentic Development Environment, built around an assistant that can read and change the files in your project.',
  },
  {
    phaseId: 'intro', stepId: 'home-start', window: 'home',
    title: 'Start here',
    body: "Everything begins on this screen. Start has the main actions, Favorites holds the projects you've starred, and Recent lists the others you've opened. Favorites and Recent fill in as you use Clara.",
    targets: ['home-start'],
    skipWhenAbsent: true,
  },
  {
    phaseId: 'intro', stepId: 'home-workspace', window: 'home',
    title: 'Your workspace',
    body: "A workspace is simply a project folder. Add one and Clara can read and search what's inside. This tour won't change the one you have open.",
    details: 'Clara can build a semantic index of a workspace and respects ignore rules by default. Choosing a folder can switch workspaces.',
    targets: ['home-add-workspace', 'home-file-menu'],
  },
  {
    phaseId: 'intro', stepId: 'home-navigation', window: 'home',
    title: 'Connect an AI model',
    body: "Clara needs an AI model to think with, and Sources is where you connect one. It can be an online service or a model running on your computer. We'll come back to this later.",
    details: 'A source pairs a provider with a model, such as a cloud API, LM Studio, or a managed local llama.cpp server.',
    targets: ['home-sources', 'home-settings-menu'],
    unavailableHint: 'Use the Settings menu to find Sources, or continue the tour.',
  },
  {
    phaseId: 'intro', stepId: 'home-models', window: 'home',
    title: 'Your model library',
    body: "Model Manager is your library of AI models, where you can download them and keep them on your computer. We'll browse it together shortly.",
    details: 'Model Manager browses Hugging Face repositories and saves the GGUF files you choose to your local model library.',
    targets: ['home-model-manager', 'home-settings-menu'],
    unavailableHint: 'Use the Settings menu to find Model Manager, or continue the tour.',
  },
  {
    phaseId: 'intro', stepId: 'home-dependencies', window: 'home',
    title: 'Running AI on your computer',
    body: "A model is the AI that reads your requests and writes Clara's replies. Online services run models for you. To run one on your own computer, you need an engine called llama.cpp, which Dependencies can install.",
    details: "Local models are GGUF files. Clara's managed local llama.cpp sources run them with llama-server; cloud APIs and separately run servers do not need it.",
    targets: ['home-dependencies', 'home-dependencies-menu'],
    unavailableHint: 'The Dependencies action is not visible here. You can still open it with the button below.',
    nextLabel: 'Open Dependencies',
  },
  {
    phaseId: 'local-engine', stepId: 'engine-intro', window: 'dependencies',
    title: 'Meet the local engine',
    body: 'This is the engine, listed here as llama-server. Clara starts it when you use a model on your computer. If you only plan to use online models, you can do without it.',
    details: 'llama-server is the runtime Clara starts for a managed local llama.cpp source. Remote or separately hosted sources can be used without installing it here.',
    targets: ['dependencies-llama'],
    unavailableHint: 'Dependencies may still be loading, or another install may be running. Retry, continue, or skip this phase.',
  },
  {
    phaseId: 'local-engine', stepId: 'engine-install', window: 'dependencies',
    title: 'Install if you want to',
    body: "If it isn't installed yet, click Download. If something goes wrong, Retry tries again. The tour won't install anything for you, and it's fine to continue without it.",
    details: 'Retry repeats the last action, including a reinstall if that is what failed.',
    targets: ['dependencies-llama-install', 'dependencies-llama-progress', 'dependencies-llama'],
    unavailableHint: 'The install button is not visible right now. Check the Dependencies window, retry, or continue without installing.',
    nextLabel: 'Continue to Home',
  },
  {
    phaseId: 'featured-models', stepId: 'home-model-manager', window: 'home',
    title: 'Explore models',
    body: "Now let's look for a model. Model Manager shows the ones you've downloaded, plus a selection to get you started. The tour won't download anything.",
    details: 'Model Manager lists local files and featured Hugging Face models. You can open it from Home or Settings.',
    targets: ['home-model-manager', 'home-settings-menu'],
    unavailableHint: 'The Home action is not visible with this layout. Use the button below to open Model Manager.',
    nextLabel: 'Open Model Manager',
  },
  {
    phaseId: 'featured-models', stepId: 'downloaded-list', window: 'settings',
    title: 'Your downloads',
    body: 'Models are kept in sections you can open and close with their arrows. Downloaded holds the ones already on your computer, and it fills up as you add more. Searching opens any section with a match.',
    details: 'Downloaded lists the GGUF files and Hugging Face folders found in your model folder.',
    targets: ['downloaded-list'],
    openDetails: 'downloaded-list',
    scrollToTarget: true,
    unavailableHint: 'Clear the Model Manager search to show Downloaded, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-intro', window: 'settings',
    title: 'Featured models',
    body: 'Featured is a hand-picked set of models to start with, grouped by size. Not every model will fit every computer, so check before you download one.',
    details: 'Featured links to curated Hugging Face GGUF repositories, and browsing their metadata uses the network. Check your RAM, GPU memory, and disk space: a featured model is not guaranteed to fit your hardware.',
    targets: ['featured-list'],
    openDetails: 'featured-list',
    scrollToTarget: true,
    unavailableHint: 'Open Model Manager and clear its search to show the Featured list, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-low', window: 'settings',
    title: 'Low models',
    body: "A model's size is its parameter count, in billions, shown as B. More parameters usually means a more capable model that needs more memory. Low models, under 15B, ask the least of your computer, so they're a good place to start.",
    details: 'Groups use the total parameters of the base language model, not file size. As a rough guide, a common Q4 quantization needs about 0.6 GB per billion parameters, plus room for context. "Low" is relative to this list and does not guarantee a model will fit or run well.',
    targets: ['featured-low'],
    openDetails: 'featured-list',
    scrollToTarget: true,
    unavailableHint: 'The Low group is hidden or unavailable. Open Featured or clear the Model Manager search, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-medium', window: 'settings',
    title: 'Medium models',
    body: 'Medium models, from 15B to 25B, can take on harder work, but they need noticeably more memory. Check that one fits before you download it.',
    details: "At the same rough rate, a 24B model at Q4 is about 14 GB. A model that doesn't fit in VRAM spills into system RAM, which runs much slower.",
    targets: ['featured-medium'],
    openDetails: 'featured-list',
    scrollToTarget: true,
    unavailableHint: 'The Medium group is hidden or unavailable. Open Featured or clear the Model Manager search, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-big', window: 'settings',
    title: 'Big models',
    body: "Big models, over 25B, need the most memory and work best with a powerful graphics card. On a smaller machine, one can slow down everything else you're running.",
    details: 'These are dense models, which use all of their parameters for every token, so they are the most demanding to run. Speed depends mostly on how much of the model fits in VRAM.',
    targets: ['featured-big'],
    openDetails: 'featured-list',
    scrollToTarget: true,
    unavailableHint: 'The Big group is hidden or unavailable. Open Featured or clear the Model Manager search, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-moe', window: 'settings',
    title: 'MoE models',
    body: 'MoE stands for Mixture of Experts. Instead of using the whole model for every word, it picks a small set of specialists, so it can respond faster than its full size suggests. The whole model still has to fit on your computer, so go by the larger number when checking memory.',
    details: 'A row like 35B MoE · 3B active means 35B in total, with about 3B active per token. Mixture-of-experts models activate only part per token, but total weights still affect storage and memory.',
    targets: ['featured-moe'],
    openDetails: 'featured-list',
    scrollToTarget: true,
    unavailableHint: 'The MoE group is hidden or unavailable. Open Featured or clear the Model Manager search, then retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-preview', window: 'settings',
    title: 'Who made this model',
    body: "Here's who created this model. If you haven't picked one, the tour may show a Low model, but anything you've already selected stays selected. Nothing gets downloaded.",
    details: "The provider identifies the base model's creator when available. With nothing selected, the tour may request metadata for the smallest visible Low model.",
    targets: ['featured-provider'],
    unavailableHint: 'Select a featured model to see who made it. Its details may still be loading or unavailable; retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-uploader', window: 'settings',
    title: 'Who shared this copy',
    body: "This is who shared this copy of the model, and it may not be the original creator. Check who they are and the license before you download.",
    details: "The uploader publishes this GGUF on Hugging Face and may differ from the model's creator.",
    targets: ['featured-uploader'],
    unavailableHint: 'Select a featured model to see who shared it. Its details may still be loading or unavailable; retry or continue.',
  },
  {
    phaseId: 'featured-models', stepId: 'featured-quantizations', window: 'settings',
    title: 'Pick a size',
    body: 'The same model often comes in several sizes. Smaller versions use less space and memory, but quality can drop. Compare them and choose what fits; downloading is always up to you.',
    details: 'GGUF is a model-file format. These versions are quantized, which generally trades precision for lower storage and memory needs. Names like Q4_K_M identify the quantization. Compare file sizes and compatibility.',
    targets: ['featured-quantizations'],
    unavailableHint: 'Select a model to see its sizes. The list may still be loading, empty, or unavailable; retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-navigation', window: 'settings',
    title: 'Open Sources',
    body: "Choose Sources here to set up where Clara's models come from. Nothing in Settings changes until you click Apply.",
    targets: ['settings-sources-nav'],
    unavailableHint: 'Find Sources in the Settings navigation, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-lm-studio', window: 'settings',
    title: 'LM Studio',
    body: 'LM Studio is a separate app for running models on your computer. If you have it, Clara can use its models.',
    targets: ['source-lm-studio-default'],
    scrollToTarget: true,
    unavailableHint: 'Open Sources to see this option, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-custom-endpoint', window: 'settings',
    title: 'Custom OpenAI Endpoint',
    body: 'This connects Clara to a model server that is already running somewhere else, using its web address.',
    targets: ['source-llama-server-url-default'],
    scrollToTarget: true,
    unavailableHint: 'Open Sources to see this option, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-openrouter', window: 'settings',
    title: 'OpenRouter',
    body: 'OpenRouter is an online service that offers many different models through one account.',
    targets: ['source-openrouter-default'],
    scrollToTarget: true,
    unavailableHint: 'Open Sources to see this option, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-claude', window: 'settings',
    title: 'Claude',
    body: 'Claude is an AI made by Anthropic. It runs online and needs an Anthropic account.',
    targets: ['source-anthropic-default'],
    scrollToTarget: true,
    unavailableHint: 'Open Sources to see this option, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-add', window: 'settings',
    title: 'Create a new source',
    body: "To run a model on your own computer, click the plus button to create a new source. It won't change what Clara is using yet. Not ready? Click Next to see an example instead.",
    details: 'This adds a managed llama.cpp source as an unapplied draft, which does not activate it for chat. You can keep using another source.',
    targets: ['sources-add'],
    unavailableHint: 'Open Sources to find Add source, then retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-model', window: 'settings',
    title: 'Choose a local model',
    body: "Pick one of your downloaded models from this list. Don't have one yet? You can get one from Model Manager. The tour won't choose for you.",
    details: 'The Local model picker lists downloaded GGUFs and Hub folders. A sample Hugging Face ID is not a downloaded model.',
    targets: ['sources-local-model'],
    unavailableHint: 'Select or add a local source first. If you have no downloaded model, you can continue without choosing one.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-defaults', window: 'settings',
    title: 'Ready-made settings',
    body: "Some models work best with particular settings, and Ready defaults offers those so you don't have to work them out yourself. Nothing is saved until you click Apply.",
    details: 'Some model creators recommend specific inference settings, and Ready defaults offers inference templates. You can review more settings under Advanced → Inference near the bottom.',
    targets: ['sources-defaults'],
    unavailableHint: 'Select a local source to see its settings, or continue without changing them.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-advanced', window: 'settings',
    title: 'Advanced options',
    body: "Most people can leave these alone, but let's take a look. Advanced is where you can fine-tune how a model runs.",
    details: 'Advanced includes llama-server launch flags and inference settings. Consult the llama.cpp wiki before changing unfamiliar options.',
    targets: ['sources-advanced'],
    openDetails: 'sources-advanced-section',
    scrollToTarget: true,
    unavailableHint: 'Select a local source to see its advanced options, or continue without changing them.',
    wiki: true,
  },
  {
    phaseId: 'local-source', stepId: 'sources-commands', window: 'settings',
    title: 'Commands',
    body: 'Each row is a command, also called a flag, that tells the engine how to run your model, like how much of a conversation it can hold at once. Clara fills these in for you, and you can change or remove them.',
    details: 'These are the llama-server flags Clara passes when it starts the model. The Raw view shows the whole command, and Reset defaults rebuilds it for this model, removing any custom flags.',
    targets: ['sources-run-flags', 'sources-run-command'],
    openDetails: 'sources-advanced-section',
    scrollToTarget: true,
    unavailableHint: 'Select a local source to see its commands, or continue without changing them.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-add-command', window: 'settings',
    title: 'Add more commands',
    body: "To add one, type in this box to search what's available, then pick it from the list. The buttons under the box are common ones you can add with a click. Nothing is saved until you click Apply.",
    details: "The search covers the flags your installed llama-server reports. If they can't be read, type a flag directly as --name value.",
    targets: ['sources-flag-add'],
    openDetails: 'sources-advanced-section',
    scrollToTarget: true,
    unavailableHint: 'Switch Run command to its Flags view to find this box, or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-vram', window: 'settings',
    title: 'Graphics card memory',
    body: "Your graphics card has its own memory, called VRAM, and a model runs best when it fits there. Choose which card to use here, and Clara estimates how much it will need. If it warns you things are tight, try a smaller model so your other apps don't slow down.",
    details: "GPU placement sets where the model loads. Split by VRAM shares it across two cards, and its slider sets each card's share (the tensor split). The estimate includes what the desktop and other apps are already using. If a card is over, lower -c or give it less of the split.",
    targets: ['sources-vram'],
    openDetails: 'sources-advanced-section',
    scrollToTarget: true,
    unavailableHint: 'This section appears when Clara detects an NVIDIA graphics card. You can continue without it.',
  },
  {
    phaseId: 'local-source', stepId: 'sources-apply', window: 'settings',
    title: 'Apply your changes',
    body: "Apply saves everything you've changed in Settings, not just this source, so give it a quick look first. The tour will never apply or discard anything for you.",
    targets: ['settings-apply'],
    unavailableHint: 'Apply appears when you have unsaved changes. The tour does not need any; retry or continue.',
  },
  {
    phaseId: 'local-source', stepId: 'tour-complete', window: 'settings',
    title: "You're ready to explore",
    body: "That's the tour! Your workspace and any changes you haven't applied are just as you left them. Set up a model on your computer whenever you like, or use an online one.",
    nextLabel: 'Finish',
    complete: true,
  },
];

export function tutorialStepFor(cursor: TutorialCursor | null | undefined): TutorialStepDescriptor | null {
  return cursor ? TUTORIAL_STEPS.find((step) => step.phaseId === cursor.phaseId && step.stepId === cursor.stepId) ?? null : null;
}
