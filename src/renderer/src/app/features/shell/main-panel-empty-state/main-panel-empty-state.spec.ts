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

  it('shows the home page with Start actions, Runtime and no workspace lists when there are none', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.componentRef.setInput('recentWorkspaces', []);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1.home__title')?.textContent?.trim()).toBe('Clara Coder');
    expect(host.textContent).not.toContain('> Clara Coder_');
    const actions = Array.from(host.querySelectorAll('.home__action')).map((el) => el.textContent?.trim());
    expect(actions).toEqual(['Add workspace…', 'Models', 'Dependencies']);
    expect(Array.from(host.querySelectorAll('.home__heading')).map((el) => el.textContent?.trim())).toEqual([
      'Start',
      'Runtime',
    ]);
    expect(host.querySelector('.home__row')).toBeNull();
    expect(host.querySelector('.home__empty')?.textContent).toContain('No workspaces yet');
    const homeDefault = host.querySelector('.home__default input') as HTMLInputElement | null;
    expect(homeDefault?.checked).toBe(false);
    expect(host.querySelector('.home__default')?.textContent).toContain('Use as default Home page');
    expect(host.querySelector('.main-panel-empty__etch')).toBeNull();
  });

  it('puts the source picker and model status in the Runtime panel', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.detectChanges();

    const runtime = (fixture.nativeElement as HTMLElement).querySelector('.home__runtime');
    expect(runtime?.querySelector('app-managed-llama-controls')).toBeTruthy();
    const rows = Array.from(runtime?.querySelectorAll('.llama-status-rows dt') ?? []).map((el) =>
      el.textContent?.trim(),
    );
    expect(rows).toEqual(['Model', 'Embeddings']);
    expect(runtime?.textContent).toContain('No model selected');
  });

  it('offers to add a model source when none are configured', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const events: string[] = [];
    fixture.componentInstance.openModelManager.subscribe(() => events.push('models'));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.detectChanges();

    const link = (fixture.nativeElement as HTMLElement).querySelector('.home__runtime .home__link') as
      | HTMLButtonElement
      | null;
    expect(link?.textContent).toContain('Add a model source');
    link?.click();
    expect(events).toEqual(['models']);
  });

  it('renders recent workspaces with their path and emits openWorkspace on click', () => {
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
    const start = host.querySelector('.home__action');
    const recents = host.querySelector('.home__list--rows');
    expect(start!.compareDocumentPosition(recents!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recents?.textContent).toContain('Alpha');
    expect(recents?.textContent).toContain('C:/tmp/alpha');
    expect(recents?.textContent).toContain('Beta');
    expect(recents?.querySelector('.home__row-age')?.textContent).toBeTruthy();

    const first = host.querySelector('.home__row-main') as HTMLButtonElement | null;
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
      (fixture.nativeElement as HTMLElement).querySelector('.home__row-age')?.textContent;
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
    const names = Array.from(host.querySelectorAll('.home__row-name')).map((el) => el.textContent?.trim());
    expect(names).toEqual(['Favorite One', 'Recent One']);
    expect(Array.from(host.querySelectorAll('.home__heading')).map((el) => el.textContent?.trim())).toEqual([
      'Start',
      'Favorites',
      'Recent',
      'Runtime',
    ]);
    const [favRow, recentRow] = Array.from(host.querySelectorAll('.home__row'));
    expect(favRow?.querySelector('.home__row-age')).toBeNull();

    const handle = favRow?.querySelector('.home__row-grip') as HTMLButtonElement | null;
    expect(handle?.classList.contains('cdk-drag-handle')).toBe(true);
    handle?.click();
    expect(toggled).toEqual([]);

    const remove = favRow?.querySelector('.home__row-action') as HTMLButtonElement | null;
    expect(remove?.getAttribute('aria-label')).toBe('Remove Favorite One from favorites');
    remove?.click();
    expect(toggled).toEqual(['ws-fav']);

    expect(recentRow?.querySelector('.home__row-grip')).toBeNull();
    const add = recentRow?.querySelector('.home__row-action') as HTMLButtonElement | null;
    expect(add?.getAttribute('aria-label')).toBe('Add Recent One to favorites');
    add?.click();
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
    expect(host.querySelectorAll('.home__row')).toHaveLength(8);
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
      '.home__default input',
    ) as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(true);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));
    expect(changes).toEqual([false]);
  });

  it('emits addWorkspace, openModelManager and openDependencies from the Start actions', () => {
    const fixture = TestBed.createComponent(MainPanelEmptyStateComponent);
    const events: string[] = [];
    fixture.componentInstance.addWorkspace.subscribe(() => events.push('add'));
    fixture.componentInstance.openModelManager.subscribe(() => events.push('models'));
    fixture.componentInstance.openDependencies.subscribe(() => events.push('deps'));
    fixture.componentRef.setInput('hasWorkspace', false);
    fixture.detectChanges();

    const actions = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.home__action'),
    ) as HTMLButtonElement[];
    actions.forEach((button) => button.click());
    expect(events).toEqual(['add', 'models', 'deps']);
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
    expect(host.querySelector('.home')).toBeNull();
    expect(host.textContent).not.toContain('Clara Coder');
    expect(host.querySelector('app-managed-llama-controls')).toBeNull();
    expect(host.querySelector('.home__default')).toBeNull();
  });
});
