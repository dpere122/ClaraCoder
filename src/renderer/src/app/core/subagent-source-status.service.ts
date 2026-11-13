import { Injectable, inject, signal } from '@angular/core';
import type { AppConfig } from '@shared/index';
import type { SubagentSource } from '@shared/subagent-sources';
import { ElectronService } from './electron.service';

/** A source as one status light shows it: grey, yellow, green. */
export type SourcePhase = 'off' | 'loading' | 'running';

type ProbedSource = Pick<SubagentSource, 'id' | 'connectionId' | 'launchable'>;

/** Main's answer, or null when the call fails or this window has no such API (a satellite, a test). */
async function answer<T>(ask: () => Promise<T>): Promise<T | null> {
  try {
    return await ask();
  } catch {
    return null;
  }
}

/**
 * Whether each chat source would answer now, for this window: a local server's state (kept live by
 * main's lifecycle events) and, for every other source, the result of main's ping.
 */
@Injectable({ providedIn: 'root' })
export class SubagentSourceStatusService {
  private readonly electron = inject(ElectronService);

  /** Local server state by connection id. */
  private readonly phases = signal<Readonly<Record<string, SourcePhase>>>({});
  /** Ping results of the sources the app does not launch, by source id; absent while unknown. */
  private readonly reachable = signal<Readonly<Record<string, boolean>>>({});

  constructor() {
    // A root service lives as long as its window, so these are never torn down.
    this.electron.llamaServerLifecycle$.subscribe((event) => {
      this.setServerPhase(
        event.modelId,
        event.phase === 'running' ? 'running' : event.phase === 'stopped' ? 'off' : 'loading',
      );
    });
    this.electron.llamaServerProcessExit$.subscribe((event) => {
      if (event.stream === 'chat') {
        this.setServerPhase(event.modelId, 'off');
      }
    });
  }

  /** A local server's state (off until main says otherwise). */
  serverPhase(source: Pick<SubagentSource, 'connectionId'>): SourcePhase {
    return this.phases()[source.connectionId] ?? 'off';
  }

  setServerPhase(connectionId: string, phase: SourcePhase): void {
    this.phases.update((current) => ({ ...current, [connectionId]: phase }));
  }

  /** A sub-agent could run on it now: its server runs, or its ping passed. */
  available(source: ProbedSource): boolean {
    return source.launchable ? this.serverPhase(source) === 'running' : this.reachable()[source.id] === true;
  }

  /** The light for a source: a server's own state, else connected, not connected, or still being asked. */
  state(source: ProbedSource): SourcePhase {
    if (source.launchable) {
      return this.serverPhase(source);
    }
    const reachable = this.reachable()[source.id];
    return reachable === undefined ? 'loading' : reachable ? 'running' : 'off';
  }

  /** Asks main for each source's state: a status read for a local server, a ping for the rest. */
  async probe(config: AppConfig, sources: readonly ProbedSource[]): Promise<void> {
    await Promise.all(
      sources.map(async (source) => {
        const payload = { modelId: source.connectionId, config };
        if (source.launchable) {
          const status = await answer(() => this.electron.llamaServerStatus(payload));
          if (status?.ok) {
            this.setServerPhase(source.connectionId, status.running ? 'running' : status.starting ? 'loading' : 'off');
          }
          return;
        }
        const ping = await answer(() => this.electron.llmSourcePing(payload));
        this.reachable.update((current) => ({ ...current, [source.id]: ping?.ok === true }));
      }),
    );
  }
}
