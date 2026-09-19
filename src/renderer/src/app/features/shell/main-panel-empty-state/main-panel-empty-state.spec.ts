import { TestBed } from '@angular/core/testing';
import type { Workspace } from '@shared/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lucideAppProviders } from '../../../lucide-setup';
import { MainPanelEmptyStateComponent } from './main-panel-empty-state';

function workspace(
  partial: Pick<Workspace, 'id' | 'name' | 'path'> & Partial<Workspace>,
): Workspace {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-09-01T12:00:00.000Z',
    ...partial,
  };
}

describe('MainPanelEmptyStateComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MainPanelEmptyStateComponent],
      providers: [...lucideAppProviders],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const homeDefault = host.querySelector(
      '.main-panel-empty__model .main-panel-empty__home-default-checkbox',
    ) as HTMLInputElement | null;
    expect(homeDefault).toBeTruthy();
    expect(homeDefault?.checked).toBe(false);
    expect(host.querySelector('.main-panel-empty__model')?.textContent).toContain('default Home page');
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
    const cta = host.querySelector('.main-panel-empty__cta');
    const recents = host.querySelector('.main-panel-empty__recents');
    expect(recents).toBeTruthy();
    expect(cta).toBeTruthy();
    expect(cta!.compareDocumentPosition(recents!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recents?.textContent).toContain('Alpha');
    expect(recents?.textContent).not.toContain('C:/tmp/alpha');
    expect(recents?.textContent).toContain('Beta');
    expect(recents?.textContent).toContain('Recent');
    expect(recents?.querySelector('.main-panel-empty__recent-opened')?.textContent).toBeTruthy();

    const first = host.querySelector('.main-panel-empty__recent-main') as HTMLButtonElement | null;
    expect(first).toBeTruthy();
    expect(first?.getAttribute('title')).toBe('C:/tmp/alpha');
    first?.click();
    expect(opened).toEqual(['ws-a']);
  });

  it('keeps last-opened labels stable when the clock crosses a minute during change detection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:14:30.000Z'));
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({
        id: 'ws-a',
        name: 'Alpha',
        path: 'C:/tmp/alpha',
        lastOpenedAt: '2026-09-01T12:00:00.000Z',
      }),
    ]);
    fixture.detectChanges();

    const opened = () =>
      (fixture.nativeElement as HTMLElement).querySelector('.main-panel-empty__recent-opened')
        ?.textContent;
    expect(opened()).toBe('14m ago');

    vi.setSystemTime(new Date('2026-09-01T12:15:05.000Z'));
    fixture.detectChanges();
    expect(opened()).toBe('14m ago');
  });

  it('lists favorites above recents and unfavorites from the minus, not the drag handle', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const toggled: string[] = [];
    fixture.componentInstance.toggleFavorite.subscribe((id) => toggled.push(id));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({
        id: 'ws-recent',
        name: 'Recent One',
        path: 'C:/tmp/recent',
        lastOpenedAt: '2026-09-01T12:00:00.000Z',
      }),
      workspace({
        id: 'ws-fav',
        name: 'Favorite One',
        path: 'C:/tmp/fav',
        favorite: true,
        favoriteOrder: 0,
      }),
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const names = Array.from(host.querySelectorAll('.main-panel-empty__recent-name')).map((el) =>
      el.textContent?.trim(),
    );
    expect(names).toEqual(['Favorite One', 'Recent One']);
    expect(host.textContent).toContain('Favorites');
    expect(
      Array.from(host.querySelectorAll('.main-panel-empty__recents-section .main-panel-empty__recents-heading')).map(
        (el) => el.textContent?.trim(),
      ),
    ).toEqual(['Favorites', 'Recent']);
    const frame = host.querySelector('.main-panel-empty__recents-frame');
    const heading = host.querySelector('.main-panel-empty__recents-heading');
    expect(frame).toBeTruthy();
    expect(heading).toBeTruthy();
    expect(frame?.contains(heading)).toBe(true);
    expect(heading?.parentElement?.classList.contains('main-panel-empty__recents-section')).toBe(true);
    expect(host.querySelector('.main-panel-empty__recent--favorite .main-panel-empty__recent-opened')).toBeNull();
    expect(host.querySelector('.main-panel-empty__recent--favorite .main-panel-empty__lead-hover')).toBeNull();

    const handle = host.querySelector('.main-panel-empty__drag') as HTMLButtonElement | null;
    expect(handle?.classList.contains('cdk-drag-handle')).toBe(true);
    handle?.click();
    expect(toggled).toEqual([]);

    const remove = host.querySelector('.main-panel-empty__remove') as HTMLButtonElement | null;
    expect(remove?.getAttribute('aria-label')).toBe('Remove favorite');
    remove?.click();
    expect(toggled).toEqual(['ws-fav']);

    const recentLead = host.querySelector(
      '.main-panel-empty__recent:not(.main-panel-empty__recent--favorite) .main-panel-empty__lead',
    ) as HTMLButtonElement | null;
    expect(recentLead?.classList.contains('cdk-drag-handle')).toBe(false);
    expect(recentLead?.querySelector('.main-panel-empty__lead-idle')).toBeTruthy();
    expect(recentLead?.querySelector('.main-panel-empty__lead-hover')).toBeTruthy();
    recentLead?.click();
    expect(toggled).toEqual(['ws-fav', 'ws-recent']);
  });

  it('emits reorderFavorites when a favorite is dropped', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const reordered: string[][] = [];
    fixture.componentInstance.reorderFavorites.subscribe((ids) => reordered.push(ids));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({ id: 'ws-a', name: 'A', path: 'C:/tmp/a', favorite: true, favoriteOrder: 0 }),
      workspace({ id: 'ws-b', name: 'B', path: 'C:/tmp/b', favorite: true, favoriteOrder: 1 }),
    ]);
    fixture.detectChanges();

    fixture.componentInstance.onFavoriteDrop({
      previousIndex: 0,
      currentIndex: 1,
    } as never);
    expect(reordered).toEqual([['ws-b', 'ws-a']]);
  });

  it('renders all recent workspaces so the list can scroll past seven', () => {
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
    expect(host.querySelectorAll('.main-panel-empty__recent')).toHaveLength(8);
    expect(host.textContent).toContain('Project 0');
    expect(host.textContent).toContain('Project 7');
  });

  it('emits defaultHomePageChange when the home-page checkbox is toggled', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const changes: boolean[] = [];
    fixture.componentInstance.defaultHomePageChange.subscribe((value) => changes.push(value));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('defaultHomePage', true);
    fixture.detectChanges();

    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      '.main-panel-empty__home-default-checkbox',
    ) as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(true);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));
    expect(changes).toEqual([false]);
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

    const host = fixture.nativeElement as HTMLElement;
    const links = Array.from(host.querySelectorAll('.main-panel-empty__link')) as HTMLButtonElement[];
    expect(links.map((el) => el.textContent?.trim())).toEqual(['Models', 'Dependencies']);
    const deps = links[1];
    const homeDefault = host.querySelector('.main-panel-empty__home-default');
    expect(homeDefault).toBeTruthy();
    expect(deps!.compareDocumentPosition(homeDefault!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    links[0]?.click();
    links[1]?.click();
    expect(events).toEqual(['models', 'deps']);
  });

  it('shows the etched Clara Coder brand when a workspace is open with no file', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', true);
    fixture.componentRef.setInput('recentWorkspaces', [
      workspace({ id: 'ws-a', name: 'Alpha', path: 'C:/tmp/alpha' }),
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.main-panel-empty__welcome--workspace')).toBeTruthy();
    expect(host.querySelector('.main-panel-empty__etch')).toBeTruthy();
    expect(host.querySelector('h2')).toBeNull();
    expect(host.textContent).not.toContain('Clara Coder');
    expect(host.textContent).not.toContain('Select a file');
    expect(host.textContent).not.toContain('Double-click a file');
    expect(host.querySelector('.main-panel-empty__cta')).toBeNull();
    expect(host.querySelector('.main-panel-empty__home-default')).toBeNull();
    expect(host.querySelector('.main-panel-empty__recents')).toBeNull();
    expect(host.querySelector('.main-panel-empty__model')).toBeNull();
  });
});
