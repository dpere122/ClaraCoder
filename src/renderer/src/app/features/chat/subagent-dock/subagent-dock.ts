import { Component, DestroyRef, computed, effect, inject, signal, ViewEncapsulation } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ConversationSessionService } from '../../shell/conversation-session.service';
import { turnActivitySpinnerKind } from '../chat-box/chat-box';
import { ToolSpinnerComponent } from '../chat-box/tool-spinner/tool-spinner';
import type { SpinnerKind } from '../chat-box/tool-spinner-kind';
import { buildSubagentCardViews, type SubagentCardView } from './subagent-dock-view';

/** Elapsed-time refresh while a sub-agent runs. */
const CLOCK_TICK_MS = 1000;

/**
 * Live preview of the sub-agents the open conversation's agent is running: one card each with
 * its state, elapsed time and what it is doing now, plus Open and Stop. Cards stay (as Done /
 * Stopped / Failed) until the parent turn that spawned them ends.
 */
@Component({
  selector: 'app-subagent-dock',
  standalone: true,
  imports: [LucideAngularModule, ToolSpinnerComponent],
  templateUrl: './subagent-dock.html',
  styleUrl: './subagent-dock.css',
  encapsulation: ViewEncapsulation.None,
})
export class SubagentDockComponent {
  private readonly session = inject(ConversationSessionService);
  private readonly now = signal(Date.now());
  private clock: ReturnType<typeof setInterval> | null = null;

  protected readonly collapsed = signal(false);

  private readonly runs = computed(() => {
    const id = this.session.activeConversationId();
    return id ? this.session.subagentRunsFor(id) : [];
  });

  protected readonly cards = computed<SubagentCardView[]>(() =>
    buildSubagentCardViews(
      this.runs(),
      (id) => this.session.streamPartsFor(id),
      (id) => this.session.finalTextFor(id),
      this.session.pendingSubagentApprovals(),
      this.now(),
    ),
  );

  protected readonly open = computed(() => this.cards().length > 0);

  protected readonly runningCount = computed(() => this.cards().filter((c) => c.live).length);

  /** `2 running · 1 done` */
  protected readonly summary = computed(() => {
    const cards = this.cards();
    const running = cards.filter((c) => c.live).length;
    const ended = cards.length - running;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (ended > 0) parts.push(`${ended} finished`);
    return parts.join(' · ');
  });

  constructor() {
    effect(() => {
      const anyLive = this.runs().some((r) => r.outcome === undefined);
      if (anyLive && this.clock === null) {
        this.now.set(Date.now());
        this.clock = setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS);
      } else if (!anyLive && this.clock !== null) {
        clearInterval(this.clock);
        this.clock = null;
      }
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.clock !== null) {
        clearInterval(this.clock);
      }
    });
  }

  /** Same spinner the conversation list shows for that sub-agent's current activity. */
  protected spinnerKind(card: SubagentCardView): SpinnerKind | null {
    if (!card.live) {
      return null;
    }
    const activity = this.session.conversationActivity().get(card.conversationId);
    return activity ? turnActivitySpinnerKind(activity) : null;
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((c) => !c);
  }

  protected openSubagent(card: SubagentCardView): void {
    this.session.openConversation(card.conversationId);
  }

  protected stopSubagent(card: SubagentCardView, event: Event): void {
    event.stopPropagation();
    this.session.stopSubagent(card.conversationId);
  }

  protected stopAll(): void {
    const id = this.session.activeConversationId();
    if (id) {
      this.session.stopAllSubagents(id);
    }
  }
}
