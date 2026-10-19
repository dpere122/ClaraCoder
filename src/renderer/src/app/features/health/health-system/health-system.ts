import { Component, computed, inject } from '@angular/core';
import type { GpuInfo } from '@shared/index';
import {
  SPARK_H,
  fmtBytesPerSec,
  fmtPercent,
  gpuVramLabel,
  gpuVramPercent,
  sparklinePaths,
  type SparklinePaths,
} from '../shared/health-format';
import { HEALTH_METRIC_POINTS, HealthMetricsStore, type HealthMetricKey } from '../shared/health-metrics-store';

interface MetricDef {
  key: HealthMetricKey;
  label: string;
  /** Fixed scale for percentages; byte rates auto-scale. */
  max?: number;
  format: (v: number) => string;
}

interface MetricTile {
  key: HealthMetricKey;
  label: string;
  value: string;
  spark: SparklinePaths;
}

const METRICS: readonly MetricDef[] = [
  { key: 'cpu', label: 'CPU', max: 100, format: (v) => fmtPercent(v, 1) },
  { key: 'mem', label: 'Memory', max: 100, format: (v) => fmtPercent(v, 1) },
  { key: 'netRx', label: 'Network in', format: fmtBytesPerSec },
  { key: 'netTx', label: 'Network out', format: fmtBytesPerSec },
  { key: 'diskR', label: 'Disk read', format: fmtBytesPerSec },
  { key: 'diskW', label: 'Disk write', format: fmtBytesPerSec },
];

/** System tab: live-stats switch, GPU cards, and sparkline tiles (SVG, colored by theme tokens). */
@Component({
  selector: 'app-health-system',
  templateUrl: './health-system.html',
  styleUrls: ['../shared/health-tone.css', './health-system.css'],
})
export class HealthSystem {
  protected readonly metrics = inject(HealthMetricsStore);
  protected readonly sparkHeight = SPARK_H;

  protected readonly tiles = computed<MetricTile[]>(() => {
    const h = this.metrics.history();
    return METRICS.map((m) => {
      const series = h[m.key];
      const last = series[series.length - 1];
      return {
        key: m.key,
        label: m.label,
        value: last == null ? '—' : m.format(last),
        spark: sparklinePaths(series, HEALTH_METRIC_POINTS, m.max),
      };
    });
  });

  protected readonly gpuVramPercent = gpuVramPercent;
  protected readonly gpuVramLabel = gpuVramLabel;

  protected gpuUtil(g: GpuInfo): string {
    return fmtPercent(g.utilPercent);
  }

  protected toggle(): void {
    void this.metrics.setEnabled(!this.metrics.enabled());
  }
}
