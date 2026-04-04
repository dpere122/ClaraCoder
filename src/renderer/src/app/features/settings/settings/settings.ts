import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import type { AppConfig, AudioTranscriptionConfig, LlmConnectionConfig, Workspace } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { THEMES, ThemeOption } from '../../layout/theme-selector/theme-selector';

type SettingsTab = 'appearance' | 'models' | 'audio' | 'workspaces';

interface EditableConnection extends LlmConnectionConfig {
  isDefault: boolean;
}

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings implements OnInit, OnDestroy {
  protected readonly selectedSettingsTab = signal<SettingsTab>('models');
  protected readonly tabs: Array<{ id: SettingsTab; label: string; description: string }> = [
    { id: 'models', label: 'Models', description: 'Providers, active chat model, and API credentials.' },
    { id: 'audio', label: 'Audio', description: 'Speech-to-text provider and transcription defaults.' },
    { id: 'appearance', label: 'Appearance', description: 'Global and no-workspace theme defaults.' },
    { id: 'workspaces', label: 'Workspaces', description: 'Attached folders, active project, and per-workspace themes.' },
  ];
  protected readonly themes: ThemeOption[] = THEMES;
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly currentWorkspace = signal<Workspace | null>(null);
  protected readonly themeId = signal('dark');
  protected readonly noWorkspaceThemeId = signal('dark');
  protected readonly connections = signal<EditableConnection[]>([]);
  protected readonly activeLlmConnectionId = signal('default-openai');
  protected readonly selectedConnectionId = signal<string | null>(null);
  protected readonly audioProvider = signal<'openai' | 'disabled' | 'google'>('openai');
  protected readonly audioBaseUrl = signal('');
  protected readonly audioModel = signal('gpt-4o-mini-transcribe');
  protected readonly audioApiKey = signal('');
  protected readonly selectedConnection = computed(() => {
    const selectedId = this.selectedConnectionId();
    return this.connections().find((connection) => connection.id === selectedId) ?? null;
  });
  protected readonly canDeleteSelectedConnection = computed(() => this.connections().length > 1);
  protected readonly selectedTabMeta = computed(() => this.tabs.find((tab) => tab.id === this.selectedSettingsTab()) ?? this.tabs[0]);

  private subscription: Subscription | null = null;

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const config = await this.electron.loadConfig();
    this.syncFromConfig(config);

    this.subscription = this.electron.config$.subscribe((nextConfig) => {
      this.syncFromConfig(nextConfig);
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  protected selectTab(tab: SettingsTab): void {
    this.selectedSettingsTab.set(tab);
  }

  protected closeSettings(): void {
    this.electron.closeSettingsWindow();
  }

  protected applyTheme(themeId: string): void {
    const theme = THEMES.find((item) => item.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }

  protected async onGlobalThemeChange(themeId: string): Promise<void> {
    const config = await this.electron.loadConfig();
    await this.electron.saveConfig({ ...config, themeId });
  }

  protected async onNoWorkspaceThemeChange(themeId: string): Promise<void> {
    const config = await this.electron.loadConfig();
    await this.electron.saveConfig({ ...config, noWorkspaceThemeId: themeId });
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

  protected selectConnection(id: string): void {
    this.selectedConnectionId.set(id);
  }

  protected async setActiveConnection(id: string): Promise<void> {
    const config = await this.electron.loadConfig();
    await this.electron.saveConfig({ ...config, activeLlmConnectionId: id });
  }

  protected async addConnection(): Promise<void> {
    const config = await this.electron.loadConfig();
    const nextConnection = this.buildNewConnection(config.llmConnections.length + 1);
    await this.electron.saveConfig({
      ...config,
      llmConnections: [...config.llmConnections, nextConnection],
    });
    this.selectedConnectionId.set(nextConnection.id);
  }

  protected async duplicateConnection(connection: EditableConnection): Promise<void> {
    const config = await this.electron.loadConfig();
    const duplicate: LlmConnectionConfig = {
      ...connection,
      id: crypto.randomUUID(),
      name: `${connection.name} Copy`,
    };

    await this.electron.saveConfig({
      ...config,
      llmConnections: [...config.llmConnections, duplicate],
    });
    this.selectedConnectionId.set(duplicate.id);
  }

  protected async removeConnection(id: string): Promise<void> {
    const config = await this.electron.loadConfig();
    if (config.llmConnections.length <= 1) {
      return;
    }

    const nextConnections = config.llmConnections.filter((connection) => connection.id !== id);
    const nextActiveId = config.activeLlmConnectionId === id ? nextConnections[0].id : config.activeLlmConnectionId;

    await this.electron.saveConfig({
      ...config,
      llmConnections: nextConnections,
      activeLlmConnectionId: nextActiveId,
    });
    this.selectedConnectionId.set(nextActiveId);
  }

  protected async updateSelectedConnection(changes: Partial<LlmConnectionConfig>): Promise<void> {
    const selected = this.selectedConnection();
    if (!selected) {
      return;
    }

    const config = await this.electron.loadConfig();
    const nextConnections = config.llmConnections.map((connection) => (
      connection.id === selected.id ? { ...connection, ...changes } : connection
    ));

    await this.electron.saveConfig({
      ...config,
      llmConnections: nextConnections,
    });
  }

  protected async onProviderChange(provider: 'openai' | 'lmstudio'): Promise<void> {
    const defaults = this.getProviderDefaults(provider);
    await this.updateSelectedConnection({
      provider,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      apiKey: defaults.apiKey,
    });
  }

  protected async updateAudioSettings(changes: Partial<AudioTranscriptionConfig>): Promise<void> {
    const config = await this.electron.loadConfig();
    await this.electron.saveConfig({
      ...config,
      audioTranscription: { ...config.audioTranscription, ...changes },
    });
  }

  protected async onAudioProviderChange(provider: 'openai' | 'disabled' | 'google'): Promise<void> {
    if (provider === 'disabled') {
      await this.updateAudioSettings({ provider });
      return;
    }

    if (provider === 'google') {
      await this.updateAudioSettings({
        provider: 'google',
        baseUrl: '',
        model: 'google-web-speech',
        apiKey: '',
      });
      return;
    }

    await this.updateAudioSettings({
      provider: 'openai',
      baseUrl: this.audioBaseUrl() || '',
      model: this.audioModel() || 'gpt-4o-mini-transcribe',
      apiKey: this.audioApiKey(),
    });
  }

  protected isConnectionActive(connectionId: string): boolean {
    return this.activeLlmConnectionId() === connectionId;
  }

  protected trackConnection(_index: number, connection: EditableConnection): string {
    return connection.id;
  }

  protected trackWorkspace(_index: number, workspace: Workspace): string {
    return workspace.id;
  }

  private buildNewConnection(index: number): LlmConnectionConfig {
    return {
      id: crypto.randomUUID(),
      name: `Connection ${index}`,
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
      apiKey: 'lm-studio',
      reasoningEffort: '',
    };
  }

  private getProviderDefaults(provider: 'openai' | 'lmstudio'): Pick<LlmConnectionConfig, 'baseUrl' | 'model' | 'apiKey'> {
    if (provider === 'lmstudio') {
      return {
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        apiKey: 'lm-studio',
      };
    }

    return {
      baseUrl: '',
      model: 'gpt-4o-mini',
      apiKey: '',
    };
  }

  private syncFromConfig(config: AppConfig): void {
    this.workspaces.set(config.workspaces);

    const currentWorkspace = config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId) ?? null;
    this.currentWorkspace.set(currentWorkspace);
    this.themeId.set(config.themeId || 'dark');
    this.noWorkspaceThemeId.set(config.noWorkspaceThemeId || config.themeId || 'dark');
    this.connections.set(config.llmConnections.map((connection) => ({
      ...connection,
      isDefault: connection.id === 'default-openai' || connection.id === 'default-lmstudio',
    })));
    this.activeLlmConnectionId.set(config.activeLlmConnectionId);
    this.audioProvider.set(config.audioTranscription.provider);
    this.audioBaseUrl.set(config.audioTranscription.baseUrl);
    this.audioModel.set(config.audioTranscription.model);
    this.audioApiKey.set(config.audioTranscription.apiKey);

    const currentSelectedId = this.selectedConnectionId();
    const nextSelectedId = currentSelectedId && config.llmConnections.some((connection) => connection.id === currentSelectedId)
      ? currentSelectedId
      : config.activeLlmConnectionId;
    this.selectedConnectionId.set(nextSelectedId);

    const themeToApply = currentWorkspace?.themeId || config.noWorkspaceThemeId || config.themeId || 'dark';
    this.applyTheme(themeToApply);
  }
}
