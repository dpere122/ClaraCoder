import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import type {
  AppConfig,
  AudioTranscriptionConfig,
  LlamaCppManaged,
  LlmConnectionConfig,
  LlmModelProfile,
  LlmOptimizationPreset,
  LlmProviderConfig,
  Workspace,
  WorkspaceToolsConfig,
} from '@shared/index';
import {
  CAPABLE_PRESET_DEFAULTS,
  defaultLlamaCppManaged,
  GEMMA_PRESET_DEFAULTS,
  countLlmModels,
  findLlmModelLocation,
  inferContextWindowTokens,
  mergeLlmProviderModel,
  optimizationPresetsForProvider,
  QWEN_PRESET_DEFAULTS,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { THEMES, ThemeOption } from '../../layout/theme-selector/theme-selector';
import { LucideAngularModule } from 'lucide-angular';

type SettingsTab = 'appearance' | 'models' | 'tools' | 'audio' | 'workspaces';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings implements OnInit, OnDestroy {
  /** Shown in managed llama-server tips and placeholders (must match Electron substitution token). */
  protected readonly managedLlamaPortToken = '{{PORT}}';
  protected readonly selectedSettingsTab = signal<SettingsTab>('models');
  protected readonly tabs: Array<{ id: SettingsTab; label: string; description: string }> = [
    {
      id: 'models',
      label: 'Models',
      description: 'Providers (base URL and API key) with multiple model presets each. Tuning is saved per model; chat uses the active model.',
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'Workspace agent tool limits and edit modes (synced to the Python backend).',
    },
    { id: 'audio', label: 'Audio', description: 'Speech-to-text provider and transcription defaults.' },
    { id: 'appearance', label: 'Appearance', description: 'Global and no-workspace theme defaults.' },
    { id: 'workspaces', label: 'Workspaces', description: 'Attached folders, active project, and per-workspace themes.' },
  ];
  protected readonly themes: ThemeOption[] = THEMES;
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly currentWorkspace = signal<Workspace | null>(null);
  protected readonly themeId = signal('dark');
  protected readonly noWorkspaceThemeId = signal('dark');
  protected readonly llmProviders = signal<LlmProviderConfig[]>([]);
  protected readonly activeLlmModelId = signal('default-openai');
  protected readonly selectedModelId = signal<string | null>(null);
  protected readonly audioProvider = signal<'openai' | 'disabled' | 'google'>('openai');
  protected readonly audioBaseUrl = signal('');
  protected readonly audioModel = signal('gpt-4o-mini-transcribe');
  protected readonly audioApiKey = signal('');
  protected readonly editToolsMode = signal<'standard' | 'strict'>('standard');
  protected readonly maxFileReadLines = signal(400);
  protected readonly maxSearchResults = signal(40);
  protected readonly defaultWorkspaceEncoding = signal('utf-8');
  protected readonly defaultWorkspaceNewline = signal<'lf' | 'crlf' | 'preserve'>('lf');
  protected readonly orchestratedMode = signal(false);
  protected readonly selectedLocation = computed(() => {
    const modelId = this.selectedModelId();
    if (!modelId) {
      return null;
    }
    return findLlmModelLocation(this.llmProviders(), modelId);
  });
  protected readonly selectedProvider = computed(() => this.selectedLocation()?.provider ?? null);
  protected readonly selectedModel = computed(() => this.selectedLocation()?.model ?? null);
  protected readonly selectedResolved = computed(() => {
    const loc = this.selectedLocation();
    if (!loc) {
      return null;
    }
    return mergeLlmProviderModel(loc.provider, loc.model);
  });
  protected readonly totalModelCount = computed(() => countLlmModels(this.llmProviders()));
  protected readonly canDeleteSelectedModel = computed(() => this.totalModelCount() > 1);
  protected readonly canDeleteSelectedProvider = computed(() => this.llmProviders().length > 1);
  protected readonly selectedTabMeta = computed(() => this.tabs.find((tab) => tab.id === this.selectedSettingsTab()) ?? this.tabs[0]);

  private subscription: Subscription | null = null;
  private configSnapshot: AppConfig | null = null;
  /** True after any local edit; we persist only on close (or teardown) instead of debouncing every keystroke. */
  private settingsDirty = false;

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electron.loadConfig();
    this.configSnapshot = structuredClone(config);
    this.syncFromConfig(config, true);

    this.subscription = this.electron.config$.subscribe((nextConfig) => {
      this.syncFromConfig(nextConfig, false);
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.configSnapshot && this.settingsDirty) {
      void this.enqueuePersist();
    }
  }

  protected selectTab(tab: SettingsTab): void {
    this.selectedSettingsTab.set(tab);
  }

  protected async closeSettings(): Promise<void> {
    await this.flushPersistForClose();
    this.electron.closeSettingsWindow();
  }

  private async flushPersistForClose(): Promise<void> {
    if (!this.configSnapshot || !this.settingsDirty) {
      return;
    }
    await this.enqueuePersist();
  }

  protected applyTheme(themeId: string): void {
    const theme = THEMES.find((item) => item.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }

  protected onGlobalThemeChange(themeId: string): void {
    this.themeId.set(themeId);
    this.markSettingsDirty();
  }

  protected onNoWorkspaceThemeChange(themeId: string): void {
    this.noWorkspaceThemeId.set(themeId);
    this.markSettingsDirty();
  }

  protected async onWorkspaceThemeChange(workspaceId: string, themeId: string): Promise<void> {
    await this.electron.setWorkspaceTheme(workspaceId, themeId);
  }

  protected async addWorkspace(): Promise<void> {
    const selected = await this.electron.openDirectoryDialog();
    if (!selected) {
      return;
    }

    const existing = this.workspaces().find((workspace) => workspace.path === selected);
    if (existing) {
      await this.selectWorkspace(existing.id);
      return;
    }

    const name = selected.split(/[\\/]/).pop() || 'New Workspace';
    await this.electron.addWorkspace(name, selected);
  }

  protected async removeWorkspace(id: string): Promise<void> {
    await this.electron.removeWorkspace(id);
  }

  protected async selectWorkspace(id: string | null): Promise<void> {
    await this.electron.setCurrentWorkspace(id);
  }

  protected selectModel(modelId: string): void {
    this.selectedModelId.set(modelId);
  }

  protected setActiveModel(modelId: string): void {
    if (!findLlmModelLocation(this.llmProviders(), modelId)) {
      return;
    }
    this.activeLlmModelId.set(modelId);
    this.markSettingsDirty();
  }

  protected addProvider(): void {
    const nextProvider = this.buildNewProvider(this.llmProviders().length + 1);
    this.llmProviders.update((p) => [...p, nextProvider]);
    this.selectedModelId.set(nextProvider.models[0]?.id ?? null);
    this.markSettingsDirty();
  }

  protected removeProvider(providerId: string): void {
    if (this.llmProviders().length <= 1) {
      return;
    }
    const removed = this.llmProviders().find((p) => p.id === providerId);
    const removedModelIds = new Set(removed?.models.map((m) => m.id) ?? []);
    const nextProviders = this.llmProviders().filter((p) => p.id !== providerId);
    let nextActive = this.activeLlmModelId();
    if (removedModelIds.has(nextActive)) {
      nextActive = nextProviders[0]?.models[0]?.id ?? nextActive;
    }
    this.llmProviders.set(nextProviders);
    this.activeLlmModelId.set(nextActive);
    this.selectedModelId.set(nextActive);
    this.markSettingsDirty();
  }

  protected addModel(providerId: string): void {
    const provider = this.llmProviders().find((p) => p.id === providerId);
    if (!provider) {
      return;
    }
    const nextModel = this.buildNewModel(provider.models.length + 1, provider.provider);
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, models: [...p.models, nextModel] } : p)),
    );
    this.selectedModelId.set(nextModel.id);
    this.markSettingsDirty();
  }

  protected removeSelectedModel(): void {
    const p = this.selectedProvider();
    const m = this.selectedModel();
    if (!p || !m) {
      return;
    }
    this.removeModel(p.id, m.id);
  }

  protected removeSelectedProvider(): void {
    const p = this.selectedProvider();
    if (!p) {
      return;
    }
    this.removeProvider(p.id);
  }

  protected removeModel(providerId: string, modelId: string): void {
    if (countLlmModels(this.llmProviders()) <= 1) {
      return;
    }
    const provider = this.llmProviders().find((p) => p.id === providerId);
    if (!provider) {
      return;
    }
    if (provider.models.length === 1) {
      this.removeProvider(providerId);
      return;
    }
    const providerNow = this.llmProviders().find((p) => p.id === providerId);
    if (!providerNow) {
      return;
    }
    const nextModels = providerNow.models.filter((m) => m.id !== modelId);
    let nextActive = this.activeLlmModelId();
    if (nextActive === modelId) {
      nextActive = nextModels[0]?.id ?? nextActive;
    }
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, models: nextModels } : p)),
    );
    this.activeLlmModelId.set(nextActive);
    this.selectedModelId.set(nextActive);
    this.markSettingsDirty();
  }

  protected duplicateModel(providerId: string, model: LlmModelProfile): void {
    const duplicate: LlmModelProfile = {
      ...model,
      id: crypto.randomUUID(),
      name: `${model.name} Copy`,
      llamaCppManaged: model.llamaCppManaged ? structuredClone(model.llamaCppManaged) : undefined,
    };
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, models: [...p.models, duplicate] } : p)),
    );
    this.selectedModelId.set(duplicate.id);
    this.markSettingsDirty();
  }

  protected updateSelectedModel(changes: Partial<LlmModelProfile>): void {
    const modelId = this.selectedModelId();
    if (!modelId) {
      return;
    }
    if (!findLlmModelLocation(this.llmProviders(), modelId)) {
      return;
    }
    this.applyLlmModelPatch(modelId, changes);
    this.markSettingsDirty();
  }

  protected updateSelectedProvider(
    changes: Partial<Pick<LlmProviderConfig, 'name' | 'provider' | 'baseUrl' | 'apiKey'>>,
  ): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    this.applyProviderPatch(loc.provider.id, changes);
    this.markSettingsDirty();
  }

  protected onProviderKindChange(provider: LlmProviderConfig['provider']): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    const defaults = this.getProviderDefaults(provider);
    this.applyProviderPatch(loc.provider.id, {
      provider,
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
    });
    this.markSettingsDirty();
  }

  protected onModelApiIdChange(model: string): void {
    const loc = this.selectedLocation();
    if (!loc) {
      return;
    }
    this.applyLlmModelPatch(loc.model.id, {
      model,
      contextWindowTokens: inferContextWindowTokens(model, loc.provider.provider),
    });
    this.markSettingsDirty();
  }

  protected onTemperatureChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, n));
    this.updateSelectedModel({ temperature: clamped });
  }

  protected presetsFor(provider: LlmProviderConfig['provider']) {
    return optimizationPresetsForProvider(provider);
  }

  protected providerKindLabel(kind: LlmProviderConfig['provider']): string {
    if (kind === 'lmstudio') {
      return 'LM Studio';
    }
    if (kind === 'llamacpp') {
      return 'llama.cpp';
    }
    return 'OpenAI';
  }

  protected presetDescription(connection: LlmConnectionConfig): string {
    return (
      optimizationPresetsForProvider(connection.provider).find((p) => p.id === connection.optimizationPreset)
        ?.description ?? ''
    );
  }

  protected formatTemperature(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : '0.00';
  }

  protected onOptimizationPresetChange(value: string): void {
    const preset: LlmOptimizationPreset =
      value === 'qwen'
        ? 'qwen'
        : value === 'capable'
          ? 'capable'
          : value === 'gemma'
            ? 'gemma'
            : 'generic';
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    if (preset === 'qwen') {
      const cap = QWEN_PRESET_DEFAULTS.temperatureCap;
      const nextTemp = Math.min(model.temperature, cap);
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'qwen',
        parallelToolCalls: QWEN_PRESET_DEFAULTS.parallelToolCalls,
        maxOutputTokens: QWEN_PRESET_DEFAULTS.maxOutputTokens,
        temperature: nextTemp,
      });
    } else if (preset === 'gemma') {
      const g = GEMMA_PRESET_DEFAULTS;
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'gemma',
        parallelToolCalls: g.parallelToolCalls,
        maxOutputTokens: g.maxOutputTokens,
        temperature: g.temperature,
        samplingPreset: g.samplingPreset,
        thinkingMode: g.thinkingMode,
        architectureHint: g.architectureHint,
        topP: g.topP,
        topK: g.topK,
      });
    } else if (preset === 'capable') {
      this.applyLlmModelPatch(model.id, {
        optimizationPreset: 'capable',
        parallelToolCalls: CAPABLE_PRESET_DEFAULTS.parallelToolCalls,
      });
    } else {
      this.applyLlmModelPatch(model.id, { optimizationPreset: 'generic' });
    }
    this.markSettingsDirty();
  }

  protected onOptionalTopPChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ topP: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ topP: undefined });
      return;
    }
    this.updateSelectedModel({ topP: Math.min(1, Math.max(0, n)) });
  }

  protected onOptionalTopKChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ topK: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ topK: undefined });
      return;
    }
    this.updateSelectedModel({ topK: Math.min(256, Math.max(1, Math.floor(n))) });
  }

  protected onOptionalMinPChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ minP: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ minP: undefined });
      return;
    }
    this.updateSelectedModel({ minP: Math.min(1, Math.max(0, n)) });
  }

  protected onOptionalPresencePenaltyChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ presencePenalty: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ presencePenalty: undefined });
      return;
    }
    this.updateSelectedModel({ presencePenalty: Math.min(2, Math.max(-2, n)) });
  }

  protected onOptionalRepeatPenaltyChange(raw: number | string | null): void {
    if (raw === null || raw === '' || (typeof raw === 'number' && Number.isNaN(raw))) {
      this.updateSelectedModel({ repeatPenalty: undefined });
      return;
    }
    const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) {
      this.updateSelectedModel({ repeatPenalty: undefined });
      return;
    }
    this.updateSelectedModel({ repeatPenalty: Math.min(4, Math.max(0.01, n)) });
  }

  protected onMaxOutputTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200_000, Math.max(0, n));
    this.updateSelectedModel({ maxOutputTokens: clamped });
  }

  protected onContextWindowTokensChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(10_000_000, Math.max(1_024, n));
    this.updateSelectedModel({ contextWindowTokens: clamped });
  }

  protected onPlanRetryAttemptsCountChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(20, Math.max(0, n));
    this.updateSelectedModel({ planRetryAttemptsCount: clamped });
  }

  protected patchLlamaCppManaged(patch: Partial<LlamaCppManaged>): void {
    const m = this.selectedModel();
    if (!m?.llamaCppManaged) {
      return;
    }
    this.updateSelectedModel({
      llamaCppManaged: { ...m.llamaCppManaged, ...patch },
    });
  }

  protected updateAudioSettings(changes: Partial<AudioTranscriptionConfig>): void {
    if (changes.provider !== undefined) {
      this.audioProvider.set(changes.provider);
    }
    if (changes.baseUrl !== undefined) {
      this.audioBaseUrl.set(changes.baseUrl);
    }
    if (changes.model !== undefined) {
      this.audioModel.set(changes.model);
    }
    if (changes.apiKey !== undefined) {
      this.audioApiKey.set(changes.apiKey);
    }
    this.markSettingsDirty();
  }

  protected updateWorkspaceTools(changes: Partial<WorkspaceToolsConfig>): void {
    if (changes.editToolsMode !== undefined) {
      this.editToolsMode.set(changes.editToolsMode === 'strict' ? 'strict' : 'standard');
    }
    if (changes.maxFileReadLines !== undefined) {
      this.maxFileReadLines.set(changes.maxFileReadLines);
    }
    if (changes.maxSearchResults !== undefined) {
      this.maxSearchResults.set(changes.maxSearchResults);
    }
    if (changes.defaultWorkspaceEncoding !== undefined) {
      this.defaultWorkspaceEncoding.set(changes.defaultWorkspaceEncoding || 'utf-8');
    }
    if (changes.defaultWorkspaceNewline !== undefined) {
      const nl = changes.defaultWorkspaceNewline;
      this.defaultWorkspaceNewline.set(nl === 'crlf' || nl === 'preserve' ? nl : 'lf');
    }
    if (changes.orchestratedMode !== undefined) {
      this.orchestratedMode.set(!!changes.orchestratedMode);
    }
    this.markSettingsDirty();
  }

  protected onEditToolsModeChange(mode: 'standard' | 'strict'): void {
    this.editToolsMode.set(mode);
    this.markSettingsDirty();
  }

  protected onMaxFileReadLinesChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(2000, Math.max(50, n));
    this.maxFileReadLines.set(clamped);
    this.markSettingsDirty();
  }

  protected onMaxSearchResultsChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(200, Math.max(1, n));
    this.maxSearchResults.set(clamped);
    this.markSettingsDirty();
  }

  protected onDefaultWorkspaceEncodingChange(value: string): void {
    const v = (value || 'utf-8').trim() || 'utf-8';
    this.defaultWorkspaceEncoding.set(v);
    this.markSettingsDirty();
  }

  protected onDefaultWorkspaceNewlineChange(value: string): void {
    const v = value === 'crlf' || value === 'preserve' ? value : 'lf';
    this.defaultWorkspaceNewline.set(v);
    this.markSettingsDirty();
  }

  protected onOrchestratedModeChange(enabled: boolean): void {
    this.orchestratedMode.set(!!enabled);
    this.markSettingsDirty();
  }

  protected onAudioProviderChange(provider: 'openai' | 'disabled' | 'google'): void {
    if (provider === 'disabled') {
      this.audioProvider.set('disabled');
      this.markSettingsDirty();
      return;
    }

    if (provider === 'google') {
      this.audioProvider.set('google');
      this.audioBaseUrl.set('');
      this.audioModel.set('google-web-speech');
      this.audioApiKey.set('');
      this.markSettingsDirty();
      return;
    }

    this.audioProvider.set('openai');
    this.audioBaseUrl.set(this.audioBaseUrl() || '');
    this.audioModel.set(this.audioModel() || 'gpt-4o-mini-transcribe');
    this.audioApiKey.set(this.audioApiKey());
    this.markSettingsDirty();
  }

  protected isModelActive(modelId: string): boolean {
    return this.activeLlmModelId() === modelId;
  }

  protected isProviderHeaderActive(providerId: string): boolean {
    return this.selectedProvider()?.id === providerId;
  }

  protected trackProvider(_index: number, provider: LlmProviderConfig): string {
    return provider.id;
  }

  protected trackModel(_index: number, model: LlmModelProfile): string {
    return model.id;
  }

  protected trackWorkspace(_index: number, workspace: Workspace): string {
    return workspace.id;
  }

  private buildNewModel(index: number, providerKind: LlmProviderConfig['provider']): LlmModelProfile {
    const apiModel = providerKind === 'lmstudio' || providerKind === 'llamacpp' ? 'local-model' : 'gpt-4o-mini';
    const base: LlmModelProfile = {
      id: crypto.randomUUID(),
      name: `Model ${index}`,
      model: apiModel,
      contextWindowTokens: inferContextWindowTokens(apiModel, providerKind),
      reasoningEffort: '',
      thinkingMode: 'default',
      samplingPreset: 'provider-default',
      architectureHint: 'auto',
      temperature: 0,
      parallelToolCalls: false,
      optimizationPreset: 'generic',
      maxOutputTokens: 0,
      planRetryAttemptsCount: 2,
    };
    if (providerKind === 'llamacpp') {
      base.llamaCppManaged = defaultLlamaCppManaged();
    }
    return base;
  }

  private buildNewProvider(index: number): LlmProviderConfig {
    const provider: LlmProviderConfig['provider'] = 'lmstudio';
    const defaults = this.getProviderDefaults(provider);
    const firstModel = this.buildNewModel(1, provider);
    return {
      id: crypto.randomUUID(),
      name: `Provider ${index}`,
      provider,
      baseUrl: defaults.baseUrl,
      apiKey: defaults.apiKey,
      models: [firstModel],
    };
  }

  private getProviderDefaults(provider: LlmProviderConfig['provider']): Pick<LlmProviderConfig, 'baseUrl' | 'apiKey'> {
    if (provider === 'lmstudio') {
      return {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'lm-studio',
      };
    }
    if (provider === 'llamacpp') {
      return {
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: '',
      };
    }

    return {
      baseUrl: '',
      apiKey: '',
    };
  }

  private markSettingsDirty(): void {
    this.settingsDirty = true;
  }

  private async enqueuePersist(): Promise<void> {
    const next = this.buildConfigForPersist();
    const saved = await this.electron.saveConfig(next);
    this.configSnapshot = structuredClone(saved);
    this.settingsDirty = false;
    this.syncFromConfig(saved, true);
  }

  private buildConfigForPersist(): AppConfig {
    if (!this.configSnapshot) {
      throw new Error('Settings config snapshot not initialized');
    }
    const base = structuredClone(this.configSnapshot);
    return {
      ...base,
      workspaces: this.workspaces(),
      currentWorkspaceId: this.currentWorkspace()?.id ?? base.currentWorkspaceId,
      themeId: this.themeId(),
      noWorkspaceThemeId: this.noWorkspaceThemeId(),
      activeLlmModelId: this.activeLlmModelId(),
      llmProviders: structuredClone(this.llmProviders()),
      audioTranscription: {
        provider: this.audioProvider(),
        baseUrl: this.audioBaseUrl(),
        model: this.audioModel(),
        apiKey: this.audioApiKey(),
      },
      workspaceTools: {
        editToolsMode: this.editToolsMode(),
        maxFileReadLines: this.maxFileReadLines(),
        maxSearchResults: this.maxSearchResults(),
        defaultWorkspaceEncoding: this.defaultWorkspaceEncoding(),
        defaultWorkspaceNewline: this.defaultWorkspaceNewline(),
        orchestratedMode: this.orchestratedMode(),
      },
    };
  }

  private applyLlmModelPatch(modelId: string, changes: Partial<LlmModelProfile>): void {
    this.llmProviders.update((providers) =>
      providers.map((p) => ({
        ...p,
        models: p.models.map((m) => {
          if (m.id !== modelId) {
            return m;
          }
          const next: LlmModelProfile = { ...m };
          const draft = next as unknown as Record<string, unknown>;
          for (const [key, val] of Object.entries(changes) as [keyof LlmModelProfile, unknown][]) {
            if (val === undefined) {
              delete draft[key as string];
            } else {
              draft[key as string] = val;
            }
          }
          return next;
        }),
      })),
    );
  }

  private applyProviderPatch(
    providerId: string,
    changes: Partial<Pick<LlmProviderConfig, 'name' | 'provider' | 'baseUrl' | 'apiKey'>>,
  ): void {
    this.llmProviders.update((providers) =>
      providers.map((p) => (p.id === providerId ? { ...p, ...changes } : p)),
    );
  }

  private syncFromConfig(config: AppConfig, forceFull: boolean): void {
    const blockEditableHydration = !forceFull && this.settingsDirty;
    if (blockEditableHydration) {
      this.workspaces.set(config.workspaces);
      const currentWorkspace =
        config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
      this.currentWorkspace.set(currentWorkspace);
      if (this.configSnapshot) {
        this.configSnapshot.workspaces = structuredClone(config.workspaces);
        this.configSnapshot.currentWorkspaceId = config.currentWorkspaceId;
        this.configSnapshot.themeId = config.themeId;
        this.configSnapshot.noWorkspaceThemeId = config.noWorkspaceThemeId;
      }
      this.themeId.set(config.themeId || 'dark');
      this.noWorkspaceThemeId.set(config.noWorkspaceThemeId || config.themeId || 'dark');
      const themeToApply = currentWorkspace?.themeId || config.noWorkspaceThemeId || config.themeId || 'dark';
      this.applyTheme(themeToApply);
      return;
    }

    this.configSnapshot = structuredClone(config);
    this.workspaces.set(config.workspaces);

    const currentWorkspace = config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
    this.currentWorkspace.set(currentWorkspace);
    this.themeId.set(config.themeId || 'dark');
    this.noWorkspaceThemeId.set(config.noWorkspaceThemeId || config.themeId || 'dark');
    this.llmProviders.set(config.llmProviders);
    this.activeLlmModelId.set(config.activeLlmModelId);
    this.audioProvider.set(config.audioTranscription.provider);
    this.audioBaseUrl.set(config.audioTranscription.baseUrl);
    this.audioModel.set(config.audioTranscription.model);
    this.audioApiKey.set(config.audioTranscription.apiKey);

    const wt = config.workspaceTools;
    this.editToolsMode.set(wt.editToolsMode === 'strict' ? 'strict' : 'standard');
    this.maxFileReadLines.set(wt.maxFileReadLines);
    this.maxSearchResults.set(wt.maxSearchResults);
    this.defaultWorkspaceEncoding.set(wt.defaultWorkspaceEncoding || 'utf-8');
    const nl = wt.defaultWorkspaceNewline;
    this.defaultWorkspaceNewline.set(
      nl === 'crlf' || nl === 'preserve' ? nl : 'lf',
    );
    this.orchestratedMode.set(!!wt.orchestratedMode);

    const currentSelected = this.selectedModelId();
    const selectedStillValid =
      currentSelected && config.llmProviders.some((p) => p.models.some((m) => m.id === currentSelected));
    const nextSelected = selectedStillValid
      ? currentSelected
      : config.activeLlmModelId;
    this.selectedModelId.set(nextSelected);

    const themeToApply = currentWorkspace?.themeId || config.noWorkspaceThemeId || config.themeId || 'dark';
    this.applyTheme(themeToApply);
  }
}
