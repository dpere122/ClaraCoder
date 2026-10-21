import {
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import type { StreamPart, ToolTrailPillState } from '@shared/index';
import {
  delegatedStreamPartMeta,
  formatToolDuration,
  isHitlTrailStreamTag,
  isReadToolPreviewStreamTag,
  isRunCommandStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  isWorkspaceReadToolLabel,
  readToolPreviewBody,
  shellStreamPartBadgeMeta,
  shellStreamPartPillState,
  streamPartIsExpandable,
  TOOL_PILL_SLOW_MS,
  toolPillLabel,
  toolPillMeta,
  toolStatusStreamPartPillState,
} from '@shared/index';
import { DelegatedShellTerminalComponent } from '../delegated-shell-terminal/delegated-shell-terminal';
import { AnsiTerminalPreComponent } from '../../../../core/ansi-terminal-pre';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import { ToolEditDiffComponent } from '../tool-edit-diff/tool-edit-diff';
import { ToolPillExpansion } from '../tool-pill-expansion';

export type AuxStreamToolPartKind = 'status' | 'shell' | 'delegated' | 'hitl';

/**
 * Bubbling DOM event (`detail` = conversation id) a sub-agent pill dispatches to open that
 * sub-agent's conversation; the chat stack hosting the transcript handles it.
 */
export const OPEN_CONVERSATION_DOM_EVENT = 'clara-open-conversation';

export function auxStreamToolPartKind(streamTag: string): AuxStreamToolPartKind {
  if (isHitlTrailStreamTag(streamTag)) {
    return 'hitl';
  }
  if (isToolTrailStatusStreamTag(streamTag)) {
    return 'status';
  }
  if (isShellStyleToolStreamTag(streamTag)) {
    return 'shell';
  }
  return 'delegated';
}

/** Pill colour state for one tool row (shared with the collapsed group pill). */
export function auxStreamToolPartPillState(part: StreamPart, live: boolean): ToolTrailPillState {
  const kind = auxStreamToolPartKind(part.streamTag);
  if (kind === 'hitl') {
    return 'neutral';
  }
  if (kind === 'status') {
    return toolStatusStreamPartPillState(part);
  }
  if (kind === 'shell' || isRunCommandStreamTag(part.streamTag)) {
    return shellStreamPartPillState(part, live);
  }
  return part.runComplete === false && live ? 'running' : 'neutral';
}

@Component({
  selector: 'app-aux-stream-tool-part',
  standalone: true,
  imports: [
    StreamToolPillComponent,
    DelegatedShellTerminalComponent,
    AnsiTerminalPreComponent,
    ToolEditDiffComponent,
    LucideAngularModule,
  ],
  templateUrl: './aux-stream-tool-part.html',
  styleUrl: './aux-stream-tool-part.css',
  encapsulation: ViewEncapsulation.None,
})
export class AuxStreamToolPartComponent {
  readonly part = input.required<StreamPart>();
  readonly live = input(false);
  /** When true, hide shell previews until the user expands. */
  readonly compactDetails = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** `spawn_subagent` rows: the sub-agent conversation the call ran. */
  readonly subagentId = computed(() => this.part().toolSubagentId ?? '');

  openSubagent(event: Event): void {
    event.stopPropagation();
    const id = this.subagentId();
    if (id) {
      this.host.nativeElement.dispatchEvent(
        new CustomEvent<string>(OPEN_CONVERSATION_DOM_EVENT, { detail: id, bubbles: true }),
      );
    }
  }

  /** The feed's open-pill state, so a pill that turns into a group keeps its call open. */
  private readonly expansion = inject(ToolPillExpansion, { optional: true });
  private readonly localExpanded = signal(false);
  readonly expanded = computed(() => this.expansion?.isOpen(this.part().streamTag) ?? this.localExpanded());

  readonly kind = computed(() => auxStreamToolPartKind(this.part().streamTag));

  readonly hitlPending = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'running');
  readonly hitlComplete = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'complete');
  readonly hitlCancelled = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'error');

  /** Verb / target / outcome for the pill (`Read · src/app.ts · 42 lines`). */
  readonly label = computed(() => toolPillLabel(this.part(), this.live()));

  readonly pillName = computed(() => this.label().verb);
  /** Raw tool name (or command) on hover, since the pill shows the friendly verb. */
  readonly pillNameTitle = computed(() => this.part().label || this.label().verb);
  readonly pillMeta = computed(() => {
    const part = this.part();
    const k = this.kind();
    if (k === 'hitl') {
      return '';
    }
    const meta = toolPillMeta(this.label());
    if (meta) {
      return meta;
    }
    if (k === 'shell') {
      return shellStreamPartBadgeMeta(part, this.live());
    }
    return k === 'delegated' ? delegatedStreamPartMeta(part) : '';
  });

  /** How long the finished call ran (`1.2s`); empty while running and for rows saved before timing. */
  readonly durationMs = computed(() => (this.kind() === 'status' ? this.part().toolDurationMs : undefined));
  readonly pillDuration = computed(() => {
    const ms = this.durationMs();
    return ms === undefined ? '' : formatToolDuration(ms);
  });
  readonly pillDurationTitle = computed(() => {
    const ms = this.durationMs();
    if (ms === undefined) {
      return '';
    }
    return ms < 1 ? 'Ran for under 1 ms' : `Ran for ${(ms / 1000).toFixed(ms < 1000 ? 3 : 1)} s`;
  });
  readonly pillDurationSlow = computed(() => (this.durationMs() ?? 0) >= TOOL_PILL_SLOW_MS);

  readonly pillState = computed(() => auxStreamToolPartPillState(this.part(), this.live()));

  readonly expandable = computed(() => {
    const k = this.kind();
    if (k === 'hitl') {
      return false;
    }
    return streamPartIsExpandable(this.part(), k);
  });

  readonly showShellPreview = computed(
    () =>
      !this.compactDetails() &&
      this.kind() === 'shell' &&
      !this.expanded() &&
      this.part().text.length > 0,
  );

  readonly isReadToolRow = computed(() => {
    const part = this.part();
    return (
      isReadToolPreviewStreamTag(part.streamTag) ||
      (this.kind() === 'status' && isWorkspaceReadToolLabel(part.label))
    );
  });

  /** Unified diff a finished edit call wrote (empty for other tools and older saved turns). */
  readonly editDiff = computed(() => (this.kind() === 'status' ? (this.part().toolDiff ?? '') : ''));

  readonly readExpandedText = computed(() => {
    const body = readToolPreviewBody(this.part().text);
    return body.trim() ? body : this.part().text;
  });

  toggleExpanded(): void {
    if (!this.expandable()) {
      return;
    }
    const open = !this.expanded();
    if (this.expansion) {
      this.expansion.set(this.part().streamTag, open);
    } else {
      this.localExpanded.set(open);
    }
  }
}
