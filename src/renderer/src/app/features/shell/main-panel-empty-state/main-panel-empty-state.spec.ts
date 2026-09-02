import { TestBed } from '@angular/core/testing';
import type { Workspace } from '@shared/index';
import { describe, expect, it, beforeEach } from 'vitest';
import { lucideAppProviders } from '../../../lucide-setup';
import { MainPanelEmptyStateComponent } from './main-panel-empty-state';

function workspace(partial: Pick<Workspace, 'id' | 'name' | 'path'>): Workspace {
  return {
    ...partial,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('MainPanelEmptyStateComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MainPanelEmptyStateComponent],
      providers: [...lucideAppProviders],
    });
  });

  it('shows the no-workspace welcome without a recents column when the list is empty', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', []);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('h2.main-panel-empty__title')).toHaveLength(1);
    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Clara Coder');
    expect(host.textContent).not.toContain('> Clara Coder_');
    expect(host.textContent).not.toContain('Need a model?');
    expect(host.querySelector('.main-panel-empty__cta')?.textContent).toContain('Add Workspace');
    expect(host.querySelector('.main-panel-empty__recents')).toBeNull();
    expect(host.querySelector('.main-panel-empty__etch')).toBeTruthy();
    expect(host.textContent).not.toContain('Select a file');
  });

  it('renders recent workspaces and emits openWorkspace on click', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const opened: string[] = [];
    fixture.componentInstance.openWorkspace.subscribe((id) => opened.push(id));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({ id: 'ws-a', name: 'Alpha', path: 'C:/tmp/alpha' }),
      workspace({ id: 'ws-b', name: 'Beta', path: 'C:/tmp/beta' }),
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const recents = host.querySelector('.main-panel-empty__recents');
    expect(recents).toBeTruthy();
    expect(recents?.textContent).toContain('Alpha');
    expect(recents?.textContent).toContain('C:/tmp/alpha');
    expect(recents?.textContent).toContain('Beta');

    const first = host.querySelector('.main-panel-empty__recent') as HTMLButtonElement | null;
    expect(first).toBeTruthy();
    first?.click();
    expect(opened).toEqual(['ws-a']);
  });

  it('caps the recent list at six workspaces', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput(
      'recentWorkspaces',
      Array.from({ length: 8 }, (_, i) =>
        workspace({ id: `ws-${i}`, name: `Project ${i}`, path: `C:/tmp/p${i}` }),
      ),
    );
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.main-panel-empty__recent')).toHaveLength(6);
    expect(host.textContent).toContain('Project 0');
    expect(host.textContent).not.toContain('Project 6');
  });

  it('emits addWorkspace from the primary CTA', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    let added = 0;
    fixture.componentInstance.addWorkspace.subscribe(() => {
      added += 1;
    });
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.detectChanges();

    const cta = (fixture.nativeElement as HTMLElement).querySelector(
      '.main-panel-empty__cta',
    ) as HTMLButtonElement | null;
    cta?.click();
    expect(added).toBe(1);
  });

  it('emits openModelManager and openDependencies from the model footer', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const events: string[] = [];
    fixture.componentInstance.openModelManager.subscribe(() => events.push('models'));
    fixture.componentInstance.openDependencies.subscribe(() => events.push('deps'));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.detectChanges();

    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.main-panel-empty__link'),
    ) as HTMLButtonElement[];
    expect(links.map((el) => el.textContent?.trim())).toEqual(['Model Manager', 'Dependencies']);
    links[0]?.click();
    links[1]?.click();
    expect(events).toEqual(['models', 'deps']);
  });

  it('shows only the select-file state when a workspace is open', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', true);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({ id: 'ws-a', name: 'Alpha', path: 'C:/tmp/alpha' }),
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Select a file');
    expect(host.textContent).toContain('Double-click a file in the workspace tree to open it here.');
    expect(host.querySelector('.main-panel-empty__cta')).toBeNull();
    expect(host.querySelector('.main-panel-empty__recents')).toBeNull();
    expect(host.querySelector('.main-panel-empty__model')).toBeNull();
    expect(host.querySelector('.main-panel-empty__etch')).toBeNull();
  });
});
