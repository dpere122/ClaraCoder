import { Component, ViewEncapsulation, computed, inject, input, signal, type OnInit } from '@angular/core';
import {
  formatToolDuration,
  isStoppedToolCall,
  TOOL_PILL_SLOW_MS,
  toolOutcomeNotes,
  toolPillGroupLabel,
  toolPillSlowestMs,
  toolPillLabel,
  toolPillMeta,
  type StreamPart,
  type ToolTrailPillState,
} from '@shared/index';
import {
  AuxStreamToolPartComponent,
  auxStreamToolPartPillState,
} from '../aux-stream-tool-part/aux-stream-tool-part';
import { StreamToolPillComponent } from '../stream-tool-pill/stream-tool-pill';
import { ToolPillExpansion } from '../tool-pill-expansion';
import { toolGlyph } from '../tool-spinner-kind';

/** One pill for back-to-back tool calls of a kind (`Read · 3 files · a.ts, b.ts`); expands to each call. */
@Component({
  selector: 'app-tool-pill-group',
  standalone: true,
  imports: [AuxStreamToolPartComponent, StreamToolPillComponent],
  templateUrl: './tool-pill-group.html',
  styleUrl: './tool-pill-group.css',
  encapsulation: ViewEncapsulation.None,
})
export class ToolPillGroupComponent implements OnInit {
  readonly parts = input.required<StreamPart[]>();
  readonly live = input(false);
  readonly compactDetails = input(false);

  private readonly expansion = inject(ToolPillExpansion, { optional: true });
  readonly expanded = signal(false);

  private readonly labels = computed(() => this.parts().map((part) => toolPillLabel(part, this.live())));
  private readonly states = computed(() => this.parts().map((part) => auxStreamToolPartPillState(part, this.live())));

  readonly group = computed(() => toolPillGroupLabel(this.labels()));
  /** The lead call's glyph; a group's calls share a verb, so they read as one tool. */
  readonly icons = computed(() => {
    const lead = this.parts()[0];
    return lead ? [toolGlyph(lead.label, lead.streamTag)] : [];
  });

  /**
   * Calls cut off when their turn was stopped or interrupted: they did not fail, they never
   * finished. A cut-off sub-agent spawn is not counted: its sub-agent kept running.
   */
  readonly stopped = computed(() => this.parts().filter(isStoppedToolCall).length);

  readonly failed = computed(() => this.states().filter((s) => s === 'error').length);

  readonly meta = computed(() =>
    [this.group().meta, ...toolOutcomeNotes(this.failed(), this.stopped())].join(' · '),
  );

  /** Slowest call's run time: parallel calls overlap, so a sum would overstate the wait. */
  private readonly slowestMs = computed(() => toolPillSlowestMs(this.parts()));
  readonly duration = computed(() => {
    const ms = this.slowestMs();
    return ms === undefined ? '' : formatToolDuration(ms);
  });
  readonly durationTitle = computed(() => `Slowest of ${this.parts().length} calls`);
  readonly durationSlow = computed(() => (this.slowestMs() ?? 0) >= TOOL_PILL_SLOW_MS);

  /** Every call on hover: `Read src/a.ts · 12 lines`. */
  readonly title = computed(() =>
    this.labels()
      .map((label, i) => {
        const ms = this.parts()[i]?.toolDurationMs;
        return [label.verb, toolPillMeta(label), ms === undefined ? '' : `(${formatToolDuration(ms)})`]
          .filter(Boolean)
          .join(' ');
      })
      .join('\n'),
  );

  readonly state = computed((): ToolTrailPillState => {
    const states = this.states();
    if (states.includes('running')) {
      return 'running';
    }
    if (states.includes('error')) {
      return 'error';
    }
    return states.includes('complete') ? 'complete' : 'neutral';
  });

  /**
   * A child call is still running in the live turn. Saved turns never glow: one stopped
   * mid-tool can keep a `running` row forever.
   */
  readonly active = computed(() => this.live() && this.state() === 'running');

  trackPart(part: StreamPart): string {
    return part.streamTag;
  }

  ngOnInit(): void {
    // A single pill the user had open just turned into this group: open the group on that call.
    const lead = this.parts()[0]?.streamTag;
    if (lead && this.expansion?.isOpen(lead)) {
      this.expanded.set(true);
    }
  }

  toggle(): void {
    this.expanded.update((v) => !v);
  }
}
