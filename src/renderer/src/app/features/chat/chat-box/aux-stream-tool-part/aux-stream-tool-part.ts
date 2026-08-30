import {
  Component,
  ViewEncapsulation,
  computed,
  input,
  signal,
} from '@angular/core';
import type { StreamPart } from '@shared/index';
import {
  delegatedStreamPartMeta,
  isHitlTrailStreamTag,
  isReadToolPreviewStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  isWorkspaceReadToolLabel,
  readToolPreviewBody,
  shellStreamPartBadgeMeta,
  shellStreamPartPillState,
  streamPartIsExpandable,
  toolStatusStreamPartMeta,
  toolStatusStreamPartPillState,
} from '@shared/index';
import { DelegatedShellTerminalComponent } from '../delegated-shell-terminal/delegated-shell-terminal';
import { AnsiTerminalPreComponent } from '../../../../core/ansi-terminal-pre';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';

export type AuxStreamToolPartKind = 'status' | 'shell' | 'delegated' | 'hitl';

@Component({
  selector: 'app-aux-stream-tool-part',
  standalone: true,
  imports: [StreamToolPillComponent, DelegatedShellTerminalComponent, AnsiTerminalPreComponent],
  templateUrl: './aux-stream-tool-part.html',
  styleUrl: './aux-stream-tool-part.css',
  encapsulation: ViewEncapsulation.None,
})
export class AuxStreamToolPartComponent {
  readonly part = input.required<StreamPart>();
  readonly live = input(false);
  /** When true, hide shell previews until the user expands. */
  readonly compactDetails = input(false);

  readonly expanded = signal(false);

  readonly kind = computed((): AuxStreamToolPartKind => {
    const tag = this.part().streamTag;
    if (isHitlTrailStreamTag(tag)) {
      return 'hitl';
    }
    if (isToolTrailStatusStreamTag(tag)) {
      return 'status';
    }
    if (isShellStyleToolStreamTag(tag)) {
      return 'shell';
    }
    return 'delegated';
  });

  readonly hitlPending = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'running');
  readonly hitlComplete = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'complete');
  readonly hitlCancelled = computed(() => this.kind() === 'hitl' && this.part().toolChainState === 'error');

  readonly pillName = computed(() => this.part().label || 'Tool');
  readonly pillMeta = computed(() => {
    const part = this.part();
    const k = this.kind();
    if (k === 'hitl') {
      return '';
    }
    if (k === 'status') {
      return toolStatusStreamPartMeta(part);
    }
    if (k === 'shell') {
      return shellStreamPartBadgeMeta(part, this.live());
    }
    return delegatedStreamPartMeta(part);
  });

  readonly pillState = computed(() => {
    const part = this.part();
    if (this.kind() === 'hitl') {
      return 'neutral' as const;
    }
    if (this.kind() === 'status') {
      return toolStatusStreamPartPillState(part);
    }
    if (this.kind() === 'shell') {
      return shellStreamPartPillState(part, this.live());
    }
    return part.runComplete === false && this.live() ? ('running' as const) : ('neutral' as const);
  });

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

  readonly readExpandedText = computed(() => {
    const body = readToolPreviewBody(this.part().text);
    return body.trim() ? body : this.part().text;
  });

  toggleExpanded(): void {
    if (this.expandable()) {
      this.expanded.update((v) => !v);
    }
  }
}
