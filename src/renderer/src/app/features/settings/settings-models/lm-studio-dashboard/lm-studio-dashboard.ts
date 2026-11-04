import { Component, ViewEncapsulation, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LM_STUDIO_PLACEHOLDER_API_KEY, SecretValue, unwrapSecret } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';
import { SettingsStore } from '../../settings/settings-store';
import { LmStudioControlsComponent } from './lm-studio-controls';
import {
  formatLmStudioTokens,
  lmStudioIsEmbedding,
  lmStudioIsLoaded,
  lmStudioModelName,
} from './lm-studio-models';

/** LM Studio source: connection and its status, the chat model, its settings, and server stats. */
@Component({
  selector: 'app-lm-studio-dashboard',
  imports: [FormsModule, LmStudioControlsComponent, LucideAngularModule, PillSelectComponent],
  templateUrl: './lm-studio-dashboard.html',
  styleUrl: './lm-studio-dashboard.css',
  encapsulation: ViewEncapsulation.None,
})
export class LmStudioDashboardComponent {
  protected readonly s = inject(SettingsStore);

  protected readonly formatTokens = formatLmStudioTokens;

  protected readonly statusView = computed(() => {
    switch (this.s.lmStudioStatus()) {
      case 'checking':
        return { tone: 'busy', icon: 'refresh-cw', label: 'Connecting…' };
      case 'connected':
        return { tone: 'ok', icon: 'check', label: 'Connected' };
      case 'stale':
        return { tone: 'warn', icon: 'triangle-alert', label: 'Base URL changed' };
      case 'offline':
        return { tone: 'err', icon: 'circle-x', label: 'Not reachable' };
      default:
        return { tone: 'idle', icon: 'circle-dashed', label: 'Not connected' };
    }
  });
  protected readonly connected = computed(() => this.s.lmStudioStatus() === 'connected');
  /** Load and unload only exist on the v1 REST API; older servers can only list. */
  protected readonly canManage = computed(() => this.connected() && this.s.lmStudioConnection()?.source !== 'v0');

  /** The saved placeholder is not a token the user chose, so the field shows it as empty. */
  protected readonly token = computed(() => {
    const key = unwrapSecret(this.s.selectedProvider()?.apiKey);
    return key === LM_STUDIO_PLACEHOLDER_API_KEY ? '' : key;
  });

  private readonly models = computed(() => this.s.lmStudioInventory());
  protected readonly chatCount = computed(() => this.models().filter((c) => !lmStudioIsEmbedding(c)).length);
  protected readonly embeddingCount = computed(() => this.models().length - this.chatCount());
  protected readonly loadedCount = computed(() => this.models().filter(lmStudioIsLoaded).length);
  protected readonly diskBytes = computed(() => this.models().reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0));

  protected readonly chatCard = computed(() => this.s.lmStudioChatCard());
  protected readonly chatLoaded = computed(() => {
    const card = this.chatCard();
    return !!card && lmStudioIsLoaded(card);
  });
  protected readonly chatBusy = computed(() => {
    const card = this.chatCard();
    return !!card && this.s.lmStudioModelBusy(card.id);
  });
  /** Loaded share of the chat model's maximum context, for the meter. */
  protected readonly contextPercent = computed(() => {
    const card = this.chatCard();
    if (!card || !card.loaded_context_length || !card.max_context_length) {
      return 0;
    }
    return Math.min(100, Math.round((card.loaded_context_length / card.max_context_length) * 100));
  });

  /** Only chat models this server lists right now; nothing while the list can't be trusted. */
  protected readonly chatOptions = computed(() =>
    this.connected()
      ? this.models()
          .filter((c) => !lmStudioIsEmbedding(c))
          .map((c) => ({
            id: c.id,
            label: [lmStudioModelName(c), c.quantization, lmStudioIsLoaded(c) ? 'loaded' : ''].filter(Boolean).join(' · '),
            title: c.id,
          }))
      : [],
  );
  protected readonly chatValue = computed(() => {
    const id = this.s.selectedModel()?.model ?? '';
    return this.chatOptions().some((o) => o.id === id) ? id : '';
  });
  protected readonly chatPlaceholder = computed(() => {
    if (!this.connected()) {
      return 'Connect to list models';
    }
    return this.chatOptions().length ? 'Select a model' : 'No chat models on this server';
  });

  constructor() {
    void this.s.refreshSecretStorage();
  }

  protected onTokenChange(value: string): void {
    this.s.updateSelectedProvider({ apiKey: SecretValue.of(value.trim() || LM_STUDIO_PLACEHOLDER_API_KEY) });
  }
}
