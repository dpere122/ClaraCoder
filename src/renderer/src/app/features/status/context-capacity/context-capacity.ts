import { Component, computed, input, signal } from '@angular/core';
import type { AppConfig } from '@shared/index';

@Component({
  selector: 'app-context-capacity',
  imports: [],
  templateUrl: './context-capacity.html',
  styleUrl: './context-capacity.css',
})
export class ContextCapacityComponent {
  /** Active app config (kept for API symmetry; the llama status dots now live beside the workspace Start/Stop). */
  readonly appConfig = input<AppConfig | null>(null);
  readonly usedTokens = input(0);
  readonly maxTokens = input(128_000);
  readonly remainingTokens = input(128_000);
  readonly usedPercentage = input(0);
  readonly compressionNotice = input('');
  /** Inline composer row — hides compression notice and uses tighter spacing. */
  readonly compact = input(false);

  private static readonly circleRadius = 16;
  private static readonly circleCircumference = 2 * Math.PI * ContextCapacityComponent.circleRadius;
  private static readonly compactNumber = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });

  protected readonly progressClass = computed(() => {
    const usedPercentage = this.usedPercentage();
    if (usedPercentage >= 95) return 'context-capacity--danger';
    if (usedPercentage >= 80) return 'context-capacity--warn';
    return 'context-capacity--healthy';
  });

  protected readonly dashOffset = computed(() => {
    const progress = Math.min(100, Math.max(0, this.usedPercentage()));
    return ContextCapacityComponent.circleCircumference * (1 - progress / 100);
  });

  protected readonly circleCircumference = ContextCapacityComponent.circleCircumference;

  protected readonly percentageLabel = computed(() => `${this.usedPercentage()}% used`);

  protected readonly metricsTooltip = computed(() => (
    `${this.formatCompact(this.usedTokens())} / ${this.formatCompact(this.maxTokens())} tokens · ${this.formatCompact(this.remainingTokens())} left · ${this.percentageLabel()}`
  ));

  private readonly pointerOver = signal(false);
  private readonly focused = signal(false);

  /** Custom popup is visible — native `title` must be omitted so Chromium does not also show it. */
  protected readonly customTooltipOpen = computed(() => this.pointerOver() || this.focused());

  /** Native OS tooltip — present only while the custom popup is not showing. */
  protected readonly nativeTitle = computed(() => (
    this.customTooltipOpen() ? null : this.metricsTooltip()
  ));

  protected onCirclePointerEnter(): void {
    this.pointerOver.set(true);
  }

  protected onCirclePointerLeave(): void {
    this.pointerOver.set(false);
  }

  protected onCircleFocusIn(): void {
    this.focused.set(true);
  }

  protected onCircleFocusOut(): void {
    this.focused.set(false);
  }

  protected formatCompact(value: number): string {
    return ContextCapacityComponent.compactNumber.format(Math.max(0, value));
  }
}
