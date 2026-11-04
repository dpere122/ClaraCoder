import { Component, ViewEncapsulation, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SecretValue,
  openAiCompatBaseUrl,
  parseOpenAiCompatExtraBody,
  unwrapSecret,
  type LlmReasoningEffort,
  type OpenAiCompatCheckStatus,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';
import { SettingsStore } from '../../settings/settings-store';

const CHECK_ICONS: Record<OpenAiCompatCheckStatus, string> = {
  ok: 'check',
  warn: 'triangle-alert',
  fail: 'circle-x',
  skipped: 'minus',
};

/**
 * Generic OpenAI-compatible source. All it can count on is a URL and chat completions, so the
 * screen centres on testing what the server accepts, and on adjusting the request to suit it.
 */
@Component({
  selector: 'app-openai-compat-dashboard',
  imports: [FormsModule, LucideAngularModule, PillSelectComponent],
  templateUrl: './openai-compat-dashboard.html',
  styleUrls: ['../lm-studio-dashboard/lm-studio-dashboard.css', './openai-compat-dashboard.css'],
  encapsulation: ViewEncapsulation.None,
})
export class OpenAiCompatDashboardComponent {
  protected readonly s = inject(SettingsStore);

  protected readonly checkIcons = CHECK_ICONS;
  protected readonly tokensFieldOptions = [
    { id: 'max_tokens', label: 'max_tokens' },
    { id: 'max_completion_tokens', label: 'max_completion_tokens' },
  ];
  protected readonly thinkingMethodOptions = [
    { id: 'none', label: 'Not controlled' },
    { id: 'reasoning_effort', label: 'reasoning_effort' },
    { id: 'reasoning', label: 'reasoning: { effort }' },
    { id: 'chat_template_kwargs', label: 'chat_template_kwargs' },
  ];

  protected readonly compat = computed(() => this.s.openAiCompatSettings());
  protected readonly connection = computed(() => this.s.selectedResolved());

  /** Where requests will go, so a URL with or without ``/v1`` is never a guess. */
  protected readonly resolvedUrl = computed(() => {
    const base = openAiCompatBaseUrl(this.s.selectedProvider()?.baseUrl ?? '');
    return base ? `${base}/chat/completions` : '';
  });
  protected readonly apiKey = computed(() => unwrapSecret(this.s.selectedProvider()?.apiKey));
  protected readonly headers = computed(() =>
    (this.s.selectedProvider()?.customHeaders ?? []).map((h) => ({ key: h.key, value: unwrapSecret(h.value) })),
  );
  protected readonly hasSecret = computed(() => !!this.apiKey() || this.headers().some((h) => h.value));

  protected readonly statusView = computed(() => {
    if (this.s.openAiCompatTestRunning()) {
      return { tone: 'busy', icon: 'refresh-cw', label: 'Testing…' };
    }
    const result = this.s.openAiCompatTestResult();
    if (!result) {
      return { tone: 'idle', icon: 'circle-dashed', label: 'Not tested' };
    }
    if (this.s.openAiCompatTestStale()) {
      return { tone: 'warn', icon: 'triangle-alert', label: 'Changed since the last test' };
    }
    if (result.checks.some((c) => c.status === 'fail')) {
      return { tone: 'err', icon: 'circle-x', label: 'Problems found' };
    }
    if (result.checks.some((c) => c.status === 'warn')) {
      return { tone: 'warn', icon: 'triangle-alert', label: 'Works, with warnings' };
    }
    return { tone: 'ok', icon: 'check', label: 'All checks passed' };
  });

  /** Set when the selected model's size came from the server rather than being typed. */
  protected readonly contextReported = computed(() => {
    const id = this.s.selectedModel()?.model;
    return !!this.s.openAiCompatModels().find((m) => m.id === id)?.contextLength;
  });

  protected readonly profileOptions = computed(() =>
    this.s.presetsFor('openai-compatible').map((preset) => ({ id: preset.id, label: preset.label, title: preset.summary })),
  );

  protected readonly thinkingOptions = computed(() => {
    const method = this.compat().thinkingMethod;
    if (method === 'none') {
      return [];
    }
    return method === 'chat_template_kwargs'
      ? [
          { id: '', label: 'Model default' },
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ]
      : [
          { id: '', label: 'Model default' },
          { id: 'off', label: 'Off' },
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
        ];
  });
  protected readonly thinkingValue = computed(() => {
    const c = this.connection();
    if (c?.thinkingMode === 'off') {
      return 'off';
    }
    if (this.compat().thinkingMethod === 'chat_template_kwargs') {
      return c?.thinkingMode === 'on' ? 'on' : '';
    }
    return c?.reasoningEffort ?? '';
  });

  protected readonly stopText = computed(() => this.compat().stop.join('\n'));
  protected readonly extraBodyError = computed(() => {
    const parsed = parseOpenAiCompatExtraBody(this.compat().extraBody);
    return parsed.ok ? '' : parsed.error;
  });

  constructor() {
    void this.s.refreshSecretStorage();
  }

  protected setHeader(index: number, changes: { key?: string; value?: string }): void {
    this.saveHeaders(this.headers().map((h, i) => (i === index ? { ...h, ...changes } : h)));
  }

  protected addHeader(): void {
    this.saveHeaders([...this.headers(), { key: '', value: '' }]);
  }

  protected removeHeader(index: number): void {
    this.saveHeaders(this.headers().filter((_, i) => i !== index));
  }

  private saveHeaders(rows: { key: string; value: string }[]): void {
    this.s.updateSelectedProvider({ customHeaders: rows.map((h) => ({ key: h.key, value: SecretValue.of(h.value) })) });
  }

  protected onApiKeyChange(value: string): void {
    this.s.updateSelectedProvider({ apiKey: SecretValue.of(value.trim()) });
  }

  protected onThinkingChange(value: string): void {
    if (value === 'off') {
      this.s.updateSelectedModel({ thinkingMode: 'off', reasoningEffort: '' });
    } else if (value === 'on') {
      this.s.updateSelectedModel({ thinkingMode: 'on', reasoningEffort: '' });
    } else {
      this.s.updateSelectedModel({ thinkingMode: 'default', reasoningEffort: value as LlmReasoningEffort });
    }
  }

  protected onStopChange(text: string): void {
    this.s.updateOpenAiCompatSettings({ stop: text.split('\n').filter((line) => line !== '').slice(0, 4) });
  }

  protected onNumberSetting(key: 'frequencyPenalty' | 'seed', raw: number | string | null): void {
    const n = typeof raw === 'number' ? raw : raw === null || raw === '' ? NaN : Number(raw);
    this.s.updateOpenAiCompatSettings({ [key]: Number.isFinite(n) ? n : null });
  }
}
