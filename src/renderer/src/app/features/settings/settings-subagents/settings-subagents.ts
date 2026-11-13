import { Component, DestroyRef, OnInit, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { FormsModule } from '@angular/forms';
import {
  cleanSubagentRoleName,
  isEditorOnlySubagentToolGroup,
  subagentLimits,
  subagentThinkingLevelOptions,
  subagentToolGroups,
  type SubagentFallback,
  type SubagentRoleConfig,
  type SubagentToolGroup,
} from '@shared/subagents-config';
import { AnthropicService } from '../../../core/anthropic.service';
import { ElectronService } from '../../../core/electron.service';
import { claudeModelOptions } from '../../../core/claude-models';
import { SubagentSourceStatusService, type SourcePhase } from '../../../core/subagent-source-status.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { SettingsStore } from '../settings/settings-store';

type SourceOption = ReturnType<SettingsStore['subagentSourceOptions']>[number];

/** A local server's one status light (grey, yellow, green) in words, and what its button does then. */
const PHASE_LABEL: Record<SourcePhase, string> = { off: 'Off', loading: 'Loading', running: 'Running' };
const PHASE_ACTION: Record<SourcePhase, string> = { off: 'Launch', loading: 'Cancel', running: 'Stop' };

/**
 * Settings → Subagents: the roles the main agent can delegate to. The list on the left only shows
 * each role; every control for a role lives in the editor beside it.
 *
 * A panel on the right holds the local servers: every local model with a run command, with one
 * status light and a button that launches the command saved in Sources. A role can pick any llama.cpp
 * source, running or not (one that is not follows the fallback setting until it runs). Any other source
 * is offered only when it passes main's ping (a cloud source with a working key, a reachable server).
 */
@Component({
  selector: 'app-settings-subagents',
  imports: [FormsModule],
  templateUrl: './settings-subagents.html',
  styleUrl: './settings-subagents.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsSubagents implements OnInit {
  protected readonly s = inject(SettingsStore);
  private readonly claude = inject(AnthropicService);
  private readonly confirm = inject(ThemedConfirmDialogService);
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sourceStatus = inject(SubagentSourceStatusService);

  protected readonly toolGroups = subagentToolGroups();
  protected readonly limits = subagentLimits();
  /** Why the last rename was refused; cleared by the next edit. */
  protected readonly nameError = signal('');

  /** The source the chat runs on, which a role without its own source follows. */
  protected readonly mainSource = computed(
    () => this.s.subagentSourceOptions().find((option) => option.connectionId === this.s.activeLlmModelId()) ?? null,
  );
  protected readonly canAddRole = computed(() => this.s.subagents().roles.length < this.limits.rolesMax);
  private readonly claudeModels = computed(() => claudeModelOptions(this.claude.models(), ''));

  /** Why the last launch failed, as the server reported it. */
  protected readonly serverError = signal('');
  /** Launches the user cancelled: their failure is not news. */
  private readonly cancelled = new Set<string>();

  protected readonly localServers = computed(() => this.s.subagentSourceOptions().filter((option) => option.launchable));
  /** Sources a role can pick: every llama.cpp source, and any other that answers now. */
  protected readonly sourceChoices = computed(() =>
    this.s.subagentSourceOptions().filter((option) => this.alwaysOffered(option) || this.sourceAvailable(option)),
  );

  constructor() {
    // The status service follows the servers; a launch that ends up running clears the last error here.
    this.electron.llamaServerLifecycle$
      .pipe(
        filter((event) => event.phase === 'running'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.serverError.set(''));
    // Ask main about each saved source once it is listed (the store loads after this view is built).
    effect(() => {
      const key = this.s
        .subagentSourceOptions()
        .filter((option) => option.saved)
        .map((option) => `${option.id}:${option.launchable}`)
        .join('|');
      if (key) {
        untracked(() => void this.probeSources());
      }
    });
  }

  protected phase(server: SourceOption): SourcePhase {
    return this.sourceStatus.serverPhase(server);
  }

  protected phaseLabel(server: SourceOption): string {
    return PHASE_LABEL[this.phase(server)];
  }

  protected serverAction(server: SourceOption): string {
    return PHASE_ACTION[this.phase(server)];
  }

  private setPhase(connectionId: string, phase: SourcePhase): void {
    this.sourceStatus.setServerPhase(connectionId, phase);
  }

  private sourceAvailable(option: SourceOption): boolean {
    return this.sourceStatus.available(option);
  }

  /** A llama.cpp source is listed even when it is not running: it can be started before the role runs. */
  private alwaysOffered(option: SourceOption): boolean {
    return option.provider === 'llamacpp';
  }

  /** A choice's label, marked when it would not answer now. */
  protected choiceLabel(source: SourceOption): string {
    return this.sourceAvailable(source) ? source.label : this.unavailableLabel(source);
  }

  /** Launches a stopped server with the command saved in Sources; stops one that runs or loads. */
  protected async toggleServer(server: SourceOption): Promise<void> {
    const config = this.s.savedConfig();
    if (!config || !server.saved) {
      return;
    }
    const payload = { modelId: server.connectionId, config };
    if (this.phase(server) !== 'off') {
      this.cancelled.add(server.connectionId);
      await this.electron.llamaServerStop(payload);
      this.setPhase(server.connectionId, 'off');
      return;
    }
    this.cancelled.delete(server.connectionId);
    this.serverError.set('');
    this.setPhase(server.connectionId, 'loading');
    const result = await this.electron.llamaServerStart(payload).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    // Success shows through the lifecycle event that reports the server ready.
    if (!result.ok) {
      this.setPhase(server.connectionId, 'off');
      if (!this.cancelled.has(server.connectionId)) {
        this.serverError.set(`${server.label}: ${result.error}`);
      }
    }
  }

  /** Reads each saved local server's state and pings every other saved source. */
  private async probeSources(): Promise<void> {
    const config = this.s.savedConfig();
    if (config) {
      await this.sourceStatus.probe(
        config,
        this.s.subagentSourceOptions().filter((option) => option.saved),
      );
    }
  }

  ngOnInit(): void {
    if (this.s.subagentSourceOptions().some((option) => option.provider === 'anthropic')) {
      void this.claude.ensureLoaded();
    }
  }

  /** The source a role names, or null when it follows the main agent or its source was removed. */
  protected roleSource(role: SubagentRoleConfig): SourceOption | null {
    return this.s.subagentSourceOptions().find((option) => option.id === role.connectionId) ?? null;
  }

  protected sourceMissing(role: SubagentRoleConfig): boolean {
    return role.connectionId !== '' && this.roleSource(role) === null;
  }

  /** The role's own source when it is not among the choices now (no key, unreachable). */
  protected unavailableSource(role: SubagentRoleConfig): SourceOption | null {
    const source = this.roleSource(role);
    return source && !this.alwaysOffered(source) && !this.sourceAvailable(source) ? source : null;
  }

  protected unavailableLabel(source: SourceOption): string {
    return `${source.label} (${source.launchable ? 'not running' : 'unavailable'})`;
  }

  /** The source a role would run on now. */
  private effectiveSource(role: SubagentRoleConfig): SourceOption | null {
    return role.connectionId ? this.roleSource(role) : this.mainSource();
  }

  protected sourceSummary(role: SubagentRoleConfig): string {
    const source = role.connectionId ? (this.roleSource(role)?.label ?? 'Source removed') : 'Same as main agent';
    return role.model ? `${source} · ${role.model}` : source;
  }

  protected accessSummary(role: SubagentRoleConfig): string {
    if (!role.enabled) {
      return 'Off';
    }
    return role.readOnly ? 'Read only' : 'Follows chat mode';
  }

  /** How the Model control works for the role's source: a Claude pick, free text, or none. */
  protected modelControl(role: SubagentRoleConfig): 'claude' | 'text' | 'none' {
    if (!role.connectionId) {
      // It runs on whatever the main agent runs on: a model picked for one source would follow it to the next.
      return 'none';
    }
    const provider = this.effectiveSource(role)?.provider;
    if (provider === 'llamacpp') {
      // A managed server runs the one model it was started with.
      return 'none';
    }
    return provider === 'anthropic' && this.claudeModels().length > 0 ? 'claude' : 'text';
  }

  protected claudeOptions(role: SubagentRoleConfig): { id: string; label: string }[] {
    const rows = this.claudeModels().map((row) => ({ id: row.id, label: row.label }));
    return role.model && !rows.some((row) => row.id === role.model) ? [{ id: role.model, label: role.model }, ...rows] : rows;
  }

  /** Claude has no off switch: the role runs at its lowest effort instead, so the option says so. */
  protected thinkingOffLabel(role: SubagentRoleConfig): string {
    return this.effectiveSource(role)?.provider === 'anthropic' ? 'Lowest effort' : 'Off';
  }

  /**
   * Levels the role's model accepts (none when its thinking is only on or off). A level the role
   * already has stays listed, so the control never shows something else than what is saved.
   */
  protected thinkingLevels(role: SubagentRoleConfig): { id: string; label: string }[] {
    const source = this.effectiveSource(role);
    const model = role.model || source?.model || '';
    const offered =
      source?.provider === 'anthropic' ? this.claude.models().find((entry) => entry.id === model)?.effortLevels : null;
    const levels: { id: string; label: string }[] = subagentThinkingLevelOptions(source?.preset, offered);
    return role.thinkingLevel && !levels.some((level) => level.id === role.thinkingLevel)
      ? [...levels, { id: role.thinkingLevel, label: role.thinkingLevel }]
      : levels;
  }

  protected sourceModel(role: SubagentRoleConfig): string {
    return this.effectiveSource(role)?.model ?? '';
  }

  /** A role on another source than the chat's sends what it reads there: say where. */
  protected otherSource(role: SubagentRoleConfig): SourceOption | null {
    const source = this.roleSource(role);
    return source && source.id !== this.mainSource()?.id ? source : null;
  }

  protected toolChecked(role: SubagentRoleConfig, group: SubagentToolGroup): boolean {
    return role.tools.includes(group) && !this.toolLocked(role, group);
  }

  /** Read only roles never get the tools that only exist in Editor mode. */
  protected toolLocked(role: SubagentRoleConfig, group: SubagentToolGroup): boolean {
    return role.readOnly && isEditorOnlySubagentToolGroup(group);
  }

  protected onToolToggle(role: SubagentRoleConfig, group: SubagentToolGroup, on: boolean): void {
    const tools = this.toolGroups.map((entry) => entry.id).filter((id) =>
      id === group ? on : role.tools.includes(id),
    );
    this.s.patchSubagentRole(role.id, { tools });
  }

  protected onCloudLimitChange(raw: string | number): void {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (Number.isNaN(n)) {
      return;
    }
    this.s.patchSubagents({ cloudConcurrency: Math.min(this.limits.cloudMax, Math.max(this.limits.cloudMin, Math.round(n))) });
  }

  protected onFallbackChange(value: SubagentFallback): void {
    this.s.patchSubagents({ fallback: value === 'fail' ? 'fail' : 'main' });
  }

  /** Renames on commit; an empty or taken name is refused and the field goes back to the old one. */
  protected onRename(role: SubagentRoleConfig, input: HTMLInputElement): void {
    const name = cleanSubagentRoleName(input.value);
    const taken = this.s
      .subagents()
      .roles.some((other) => other.id !== role.id && other.name.toLowerCase() === name.toLowerCase());
    if (!name || taken) {
      this.nameError.set(name ? `Another role is already named ${name}.` : 'A role needs a name.');
      input.value = role.name;
      return;
    }
    this.nameError.set('');
    input.value = name;
    if (name !== role.name) {
      this.s.patchSubagentRole(role.id, { name });
    }
  }

  protected onSourceChange(role: SubagentRoleConfig, connectionId: string): void {
    // A model or level picked for the old source means nothing on the new one.
    this.s.patchSubagentRole(role.id, { connectionId, model: '', thinkingLevel: '' });
  }

  protected selectRole(role: SubagentRoleConfig): void {
    this.nameError.set('');
    this.s.selectedSubagentRoleId.set(role.id);
  }

  protected async deleteRole(role: SubagentRoleConfig): Promise<void> {
    const result = await this.confirm.open({
      title: 'Delete role?',
      message: `Delete the role ${role.name}?`,
      detail: 'The main agent can no longer hand work to it. Running subagents are not affected.',
      confirmText: 'Delete',
      variant: 'warning',
    });
    if (result === 'confirm') {
      this.s.removeSubagentRole(role.id);
    }
  }
}
