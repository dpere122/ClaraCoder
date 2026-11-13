import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { AppConfig, ModelManagerFileEntry } from '@shared/index';
import { managedLlamaSourceDisplayName } from '@shared/index';
import { subagentSources, type SubagentSource } from '@shared/subagent-sources';
import { normalizeSubagentsConfig } from '@shared/subagents-config';
import { ElectronService } from '../../../../core/electron.service';
import { SubagentSourceStatusService, type SourcePhase } from '../../../../core/subagent-source-status.service';

interface RoleRow {
  id: string;
  name: string;
  source: string;
  state: SourcePhase;
  /** The light's meaning in words (its tooltip and accessible name). */
  status: string;
}

function statusWord(state: SourcePhase, source: SubagentSource | null): string {
  if (!source) {
    return 'Source removed';
  }
  if (source.launchable) {
    return state === 'running' ? 'Server running' : state === 'loading' ? 'Server loading' : 'Server off';
  }
  return state === 'running' ? 'Connected' : state === 'loading' ? 'Checking' : 'Not connected';
}

/**
 * Home page → Subagents: the roles the main agent can use, each with one light for whether its
 * source would answer now (a local server's state, or the connection to any other source).
 */
@Component({
  selector: 'app-home-subagents',
  templateUrl: './home-subagents.html',
  styleUrl: './home-subagents.css',
})
export class HomeSubagentsComponent {
  private readonly electron = inject(ElectronService);
  private readonly sourceStatus = inject(SubagentSourceStatusService);

  readonly appConfig = input<AppConfig | null>(null);
  /** Asks the shell to open Settings → Subagents. */
  readonly openSettings = output<void>();

  /** Local model files, for the names of local sources without a custom name. */
  private readonly inventory = signal<ModelManagerFileEntry[]>([]);
  private readonly customModelsDir = computed(() => this.appConfig()?.modelManager?.customModelsDir?.trim() ?? '');

  protected readonly settings = computed(() => normalizeSubagentsConfig(this.appConfig()?.subagents));
  private readonly sources = computed(() =>
    subagentSources(this.appConfig()?.llmProviders ?? [], (provider) =>
      managedLlamaSourceDisplayName(provider, this.inventory()),
    ),
  );
  private readonly mainSource = computed(
    () => this.sources().find((source) => source.connectionId === this.appConfig()?.activeLlmModelId) ?? null,
  );
  /** Each enabled role with the source it would run on (its own, or the main agent's); none while subagents are off. */
  private readonly roleSources = computed(() => {
    const settings = this.settings();
    return (settings.enabled ? settings.roles : [])
      .filter((role) => role.enabled)
      .map((role) => ({
        role,
        source: role.connectionId
          ? (this.sources().find((source) => source.id === role.connectionId) ?? null)
          : this.mainSource(),
      }));
  });

  protected readonly rows = computed<RoleRow[]>(() =>
    this.roleSources().map(({ role, source }) => {
      const state = source ? this.sourceStatus.state(source) : 'off';
      return {
        id: role.id,
        name: role.name,
        source: source?.label ?? 'Source removed',
        state,
        status: statusWord(state, source),
      };
    }),
  );

  constructor() {
    effect(() => {
      const dir = this.customModelsDir();
      untracked(() => void this.loadInventory(dir));
    });
    // Ask main about the sources the roles use, again on every config change: the set, the main
    // source, or a source's own URL or key may be what changed.
    effect(() => {
      const used = this.roleSources().flatMap(({ source }) => (source ? [source] : []));
      const key = [...new Set(used.map((source) => `${source.id}:${source.connectionId}:${source.launchable}`))].join('|');
      const config = untracked(() => this.appConfig());
      if (key && config) {
        const unique = [...new Map(used.map((source) => [source.id, source])).values()];
        untracked(() => void this.sourceStatus.probe(config, unique));
      }
    });
  }

  private async loadInventory(customDir: string): Promise<void> {
    if (!customDir) {
      this.inventory.set([]);
      return;
    }
    const result = await this.electron.modelManagerListCustomModels({ customDir }).catch(() => null);
    this.inventory.set(result?.ok ? result.models : []);
  }
}
