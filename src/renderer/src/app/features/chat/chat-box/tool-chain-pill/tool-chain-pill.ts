import {

  Component,

  ViewEncapsulation,

  computed,

  input,

  signal,

} from '@angular/core';

import {

  condenseToolTrailText,

  isWorkspaceReadToolLabel,

  readToolPreviewBody,

  readToolPreviewTailForDisplay,

  shouldShowReadToolPreview,

  toolStatusStreamPartMeta,

} from '@shared/index';

import type { ConversationMessage } from '@shared/index';

import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';

import { AnsiTerminalPreComponent } from '../../../../core/ansi-terminal-pre';

import type { ToolTrailPillState } from '@shared/index';



type ChainMessage = Extract<ConversationMessage, { role: 'chain' }>;



@Component({

  selector: 'app-tool-chain-pill',

  standalone: true,

  imports: [StreamToolPillComponent, AnsiTerminalPreComponent],

  templateUrl: './tool-chain-pill.html',

  styleUrl: './tool-chain-pill.css',

  encapsulation: ViewEncapsulation.None,

})

export class ToolChainPillComponent {

  readonly trail = input.required<ChainMessage>();

  readonly live = input(false);

  /** When true, show pill only — hide read tail previews until the user expands. */
  readonly compactDetails = input(false);

  readonly expanded = signal(false);



  readonly pillMeta = computed(() => {

    const t = this.trail();

    if (isWorkspaceReadToolLabel(t.label)) {

      return toolStatusStreamPartMeta({

        streamTag: 'tool-trail:chain',

        label: t.label,

        text: t.text,

        toolChainState: t.state === 'running' ? 'running' : t.state === 'error' ? 'error' : 'complete',

      });

    }

    const detail = condenseToolTrailText(t.text, 72);

    if (detail) {

      return detail;

    }

    if (t.state === 'running') {

      return 'Running…';

    }

    if (t.state === 'error') {

      return 'Error';

    }

    return 'Done';

  });



  readonly pillState = computed((): ToolTrailPillState => {

    const s = this.trail().state;

    if (s === 'running') {

      return 'running';

    }

    if (s === 'error') {

      return 'error';

    }

    return 'complete';

  });



  readonly isReadTool = computed(() => isWorkspaceReadToolLabel(this.trail().label));



  readonly showReadPreview = computed(() => {
    if (this.compactDetails() || this.expanded()) {
      return false;
    }
    const t = this.trail();
    return shouldShowReadToolPreview(t.text, t.label, t.streamTag ?? '');
  });



  readonly readPreviewTailText = computed(() => readToolPreviewTailForDisplay(this.trail().text));



  readonly readExpandedText = computed(() => {

    const body = readToolPreviewBody(this.trail().text);

    return body.trim() ? body : this.trail().text;

  });



  readonly expandable = computed(() => this.trail().text.trim().length > 0);



  toggleExpanded(): void {

    if (this.expandable()) {

      this.expanded.update((v) => !v);

    }

  }

}


