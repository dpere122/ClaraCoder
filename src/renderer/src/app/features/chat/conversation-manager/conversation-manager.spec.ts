import { TestBed } from '@angular/core/testing';
import type { ConversationMeta } from '@shared/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { lucideAppProviders } from '../../../lucide-setup';
import { ConversationManager } from './conversation-manager';

function meta(id: string, title: string, parentConversationId?: string): ConversationMeta {
  const at = new Date().toISOString();
  return {
    id,
    title,
    createdAt: at,
    updatedAt: at,
    workspaceId: 'ws-1',
    customTitle: false,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

function titles(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.conv-title')).map((el) => el.textContent?.trim() ?? '');
}

describe('ConversationManager', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ConversationManager],
      providers: [...lucideAppProviders],
    });
  });

  it("draws the running tool's own glyph on the row, as its pill does in the chat", () => {
    const fixture = TestBed.createComponent(ConversationManager);
    fixture.componentRef.setInput('conversations', [meta('c1', 'Fetch docs'), meta('c2', 'Idle chat')]);
    fixture.componentRef.setInput('activity', new Map([['c1', { activity: 'web', spinner: 'fetch' }]]));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const icons = host.querySelectorAll('.conv-activity');
    expect(icons.length).toBe(1);
    expect(icons[0]!.classList).toContain('conv-activity--web');
    expect(icons[0]!.getAttribute('aria-label')).toBe('Browsing the web');
    expect(icons[0]!.querySelector('app-tool-spinner .ts-fetch')).not.toBeNull();

    fixture.componentRef.setInput('activity', new Map([['c1', { activity: 'review', spinner: null }]]));
    fixture.detectChanges();
    expect(host.querySelector('.conv-activity app-tool-spinner')).toBeNull();
    expect(host.querySelector('.conv-activity--review')).not.toBeNull();
  });

  it('shows matching sub-agents under a parent the user collapsed before filtering', async () => {
    const fixture = TestBed.createComponent(ConversationManager);
    fixture.componentRef.setInput('conversations', [
      meta('p1', 'Refactor parser'),
      meta('c1', 'Lint fixes', 'p1'),
    ]);
    fixture.componentRef.setInput('activeId', 'p1');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(titles(host)).toEqual(['Refactor parser', 'Lint fixes']);

    (host.querySelector('.conv-expand') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(titles(host)).toEqual(['Refactor parser']);

    const input = host.querySelector('.conv-filter__input') as HTMLInputElement;
    input.value = 'lint';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(titles(host)).toEqual(['Refactor parser', 'Lint fixes']);

    // Collapsing while filtered still works, and clearing the filter restores the earlier choice.
    (host.querySelector('.conv-expand') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(titles(host)).toEqual(['Refactor parser']);

    (host.querySelector('.conv-filter__clear') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(titles(host)).toEqual(['Refactor parser']);
  });
});
