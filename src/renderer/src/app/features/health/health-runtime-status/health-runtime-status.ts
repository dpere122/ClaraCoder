import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import type { DependencyInfo, DependencyState, RuntimeHealthSnapshot } from '@shared/index';
import { DEPENDENCY_LABELS } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';

type ChipTone = 'ok' | 'warn' | 'error' | 'muted';

interface StatusChip {
  key: string;
  label: string;
  detail: string;
  tone: ChipTone;
}

const POLL_MS = 4000;

function depTone(state: DependencyState): ChipTone {
  if (state === 'installed') return 'ok';
  if (state === 'updating') return 'warn';
  if (state === 'error') return 'error';
  return 'muted';
}

function depDetail(dep: DependencyInfo): string {
  if (dep.state === 'installed') return dep.version ? `v${dep.version}` : 'installed';
  if (dep.state === 'updating') return 'updating…';
  if (dep.state === 'error') return dep.error?.slice(0, 48) || 'error';
  return 'missing';
}

@Component({
  selector: 'app-health-runtime-status',
  templateUrl: './health-runtime-status.html',
  styleUrl: './health-runtime-status.css',
})
export class HealthRuntimeStatus implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private offProgress: (() => void) | null = null;

  protected readonly chips = signal<StatusChip[]>([]);
  protected readonly stale = signal(false);

  ngOnInit(): void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    this.offProgress = this.electron.onDepsProgress(() => {
      void this.refresh();
    });
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.offProgress?.();
    this.offProgress = null;
  }

  protected openDependencies(): void {
    this.electron.openDependenciesWindow();
  }

  private async refresh(): Promise<void> {
    const snap = await this.electron.healthRuntimeSnapshot();
    if (!snap) {
      this.stale.set(true);
      this.chips.set([
        { key: 'python', label: 'Python', detail: 'unavailable', tone: 'muted' },
      ]);
      return;
    }
    this.stale.set(false);
    this.chips.set(this.buildChips(snap));
  }

  private buildChips(snap: RuntimeHealthSnapshot): StatusChip[] {
    const out: StatusChip[] = [
      {
        key: 'python',
        label: 'Python',
        detail: snap.python.healthy ? 'sidecar up' : 'sidecar down',
        tone: snap.python.healthy ? 'ok' : 'error',
      },
    ];
    for (const dep of snap.dependencies) {
      out.push({
        key: dep.id,
        label: DEPENDENCY_LABELS[dep.id] ?? dep.label,
        detail: depDetail(dep),
        tone: depTone(dep.state),
      });
    }
    const llamaDetail = !snap.llama.binaryInstalled
      ? 'binary missing'
      : snap.llama.runningCount > 0
        ? `${snap.llama.runningCount} running · ${snap.llama.health}`
        : 'idle';
    let llamaTone: ChipTone = 'muted';
    if (!snap.llama.binaryInstalled) llamaTone = 'muted';
    else if (snap.llama.health === 'error') llamaTone = 'error';
    else if (snap.llama.runningCount > 0 && snap.llama.health === 'ok') llamaTone = 'ok';
    else if (snap.llama.runningCount > 0) llamaTone = 'warn';
    else llamaTone = 'ok';
    out.push({
      key: 'llama-runtime',
      label: 'Llama runtime',
      detail: llamaDetail,
      tone: llamaTone,
    });
    const lspDetail = snap.lsp.javaInstalled
      ? snap.lsp.activeSessions > 0
        ? `${snap.lsp.activeSessions} session${snap.lsp.activeSessions === 1 ? '' : 's'}`
        : 'JDT ready'
      : 'Java LSP missing';
    out.push({
      key: 'lsp',
      label: 'LSP',
      detail: lspDetail,
      tone: snap.lsp.javaInstalled ? 'ok' : 'muted',
    });
    return out;
  }
}
