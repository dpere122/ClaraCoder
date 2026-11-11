import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultDependencyCatalog,
  type AppConfig,
  type DependencyActionResult,
  type DependencyId,
  type DependencyInfo,
  type DependencyProgressEvent,
} from '@shared/index';
import type { ElectronService as ElectronServiceType } from '../../core/electron.service';
import type { ThemedConfirmDialogService as ThemedConfirmDialogServiceType } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import type { Dependencies as DependenciesComponent } from '../dependencies/dependencies/dependencies';

let ElectronService!: typeof ElectronServiceType;
let ThemedConfirmDialogService!: typeof ThemedConfirmDialogServiceType;
let Dependencies!: typeof DependenciesComponent;
type ListResult = Awaited<ReturnType<ElectronServiceType['depsList']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function catalog(
  llamaState: DependencyInfo['state'],
  javaState: DependencyInfo['state'] = 'missing',
): DependencyInfo[] {
  return defaultDependencyCatalog()
    .filter((dep) => dep.id === 'llama-server' || dep.id === 'java-lsp')
    .map((dep) => {
      const state = dep.id === 'llama-server' ? llamaState : javaState;
      return { ...dep, state, path: state === 'installed' ? `/runtime/${dep.id}` : null };
    });
}

function list(llamaState: DependencyInfo['state'], javaState: DependencyInfo['state'] = 'missing'): ListResult {
  return { ok: true, dependencies: catalog(llamaState, javaState) };
}

function setup(initial: ListResult = list('missing'), firstRequest?: Promise<ListResult>) {
  const install = deferred<DependencyActionResult>();
  const reinstall = deferred<DependencyActionResult>();
  const deletion = deferred<DependencyActionResult>();
  let listResult = initial;
  let progress: ((event: DependencyProgressEvent) => void) | null = null;
  const depsList = vi.fn<() => Promise<ListResult>>(async () => listResult);
  if (firstRequest) depsList.mockImplementationOnce(() => firstRequest);
  const electron = {
    config$: new Subject<AppConfig>(),
    loadConfig: vi.fn(async () => ({ uiFontSizeRem: 1, uiFontFamily: '', codeFontFamily: '' }) as AppConfig),
    depsList,
    depsInstall: vi.fn((_id: DependencyId, _variant?: string | null) => install.promise),
    depsReinstall: vi.fn((_id: DependencyId, _variant?: string | null) => reinstall.promise),
    depsDelete: vi.fn((_id: DependencyId) => deletion.promise),
    depsCancel: vi.fn(async (_id: DependencyId) => ({ ok: true })),
    closeDependenciesWindow: vi.fn(),
    onDepsProgress: vi.fn((callback: (event: DependencyProgressEvent) => void) => {
      progress = callback;
      return () => { progress = null; };
    }),
  };
  TestBed.configureTestingModule({
    imports: [Dependencies],
    providers: [
      { provide: ElectronService, useValue: electron },
      { provide: NgxSpinnerService, useValue: { getSpinner: () => NEVER, show: vi.fn(), hide: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(Dependencies);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    electron,
    install,
    reinstall,
    deletion,
    setList: (value: ListResult) => { listResult = value; },
    emit: (event: DependencyProgressEvent) => progress?.(event),
  };
}

async function flush(fixture: ComponentFixture<DependenciesComponent>): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  fixture.detectChanges();
  await Promise.resolve();
}

function target(host: HTMLElement, name: string): HTMLElement {
  const matches = host.querySelectorAll<HTMLElement>(`[data-tutorial="${name}"]`);
  expect(matches, `expected one ${name} target`).toHaveLength(1);
  return matches[0]!;
}

function state(host: HTMLElement): string | null {
  return target(host, 'dependencies-llama').getAttribute('data-tutorial-llama-state');
}

function busy(host: HTMLElement, name = 'data-tutorial-llama-busy'): string | null {
  return target(host, 'dependencies-llama').getAttribute(name);
}

function click(host: HTMLElement, name: string): void {
  (target(host, name) as HTMLButtonElement).click();
}

beforeAll(async () => {
  // A previous suite may have cached this chunk before Vite initialized its shared
  // class-field imports. Reload the graph and use matching provider tokens.
  vi.resetModules();
  await import('@shared/index');
  ({ ElectronService } = await import('../../core/electron.service'));
  ({ ThemedConfirmDialogService } = await import('../../shared/themed-confirm-dialog/themed-confirm-dialog.service'));
  ({ Dependencies } = await import('../dependencies/dependencies/dependencies'));
});

beforeEach(() => {
  TestBed.resetTestingModule();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Dependencies tutorial state', () => {
  it('exposes checking and an already-installed acknowledgement without starting anything', async () => {
    const initial = deferred<ListResult>();
    const h = setup(list('installed'), initial.promise);
    const shell = h.host.querySelector<HTMLElement>('.deps-shell')!;
    expect(state(h.host)).toBe('checking');
    expect(target(h.host, 'dependencies-llama').getAttribute('data-tutorial-llama-visible')).toBe('false');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('true');

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(shell, { attributes: true, childList: true, subtree: true });
    initial.resolve(list('installed'));
    await flush(h.fixture);
    expect(state(h.host)).toBe('installed');
    expect(busy(h.host)).toBe('false');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('false');
    expect(target(h.host, 'dependencies-llama').getAttribute('data-tutorial-llama-visible')).toBe('true');
    expect(target(h.host, 'dependencies-llama-progress').textContent).toContain('Installed');
    expect(h.host.querySelector('[data-tutorial="dependencies-llama-install"]')).toBeNull();
    expect(mutations.some((record) => record.attributeName === 'data-tutorial-llama-state')).toBe(true);
    expect(h.electron.depsInstall).not.toHaveBeenCalled();
    expect(h.electron.depsReinstall).not.toHaveBeenCalled();
    expect(h.electron.depsCancel).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
    observer.disconnect();
  });

  it('waits for the specific install result and a fresh installed status before success', async () => {
    const h = setup();
    await flush(h.fixture);
    expect(state(h.host)).toBe('missing');
    expect(target(h.host, 'dependencies-llama').contains(target(h.host, 'dependencies-llama-install'))).toBe(true);
    expect(h.electron.depsInstall).not.toHaveBeenCalled();

    const verification = deferred<ListResult>();
    h.electron.depsList.mockImplementationOnce(() => verification.promise);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    expect(h.electron.depsInstall).toHaveBeenCalledTimes(1);
    expect(h.electron.depsInstall).toHaveBeenCalledWith('llama-server', 'auto');
    expect(state(h.host)).toBe('installing');
    expect(busy(h.host)).toBe('true');
    expect(target(h.host, 'dependencies-llama-progress').classList.contains('deps-progress')).toBe(true);

    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server ready (cpu)' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('installing');
    expect(h.host.querySelector('.deps-focused')).not.toBeNull();
    expect(h.electron.depsList).toHaveBeenCalledTimes(1);

    h.install.resolve({ ok: true });
    await flush(h.fixture);
    expect(h.electron.depsList).toHaveBeenCalledTimes(2);
    expect(state(h.host)).toBe('installing');
    expect(busy(h.host)).toBe('true');
    vi.useFakeTimers();
    verification.resolve(list('installed'));
    await flush(h.fixture);
    expect(state(h.host)).toBe('success');
    expect(busy(h.host)).toBe('false');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('false');
    expect(h.host.textContent).toContain('Downloaded llama-server.');
    vi.advanceTimersByTime(6001);
    await flush(h.fixture);
    expect(h.host.textContent).not.toContain('Downloaded llama-server.');
    expect(state(h.host)).toBe('success');

    // A later removal invalidates the old success; a new unowned install still needs acknowledgement.
    vi.useRealTimers();
    h.setList(list('missing'));
    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server removed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('missing');
    h.setList(list('installed'));
    h.emit({ depId: 'llama-server', phase: 'done', message: 'Already installed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('installed');
  });

  it('does not turn an unowned done or delete completion into an install success', async () => {
    const h = setup(list('installed'));
    await flush(h.fixture);
    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server removed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('installed'); // Only an explicit already-installed acknowledgement is valid.

    vi.spyOn(TestBed.inject(ThemedConfirmDialogService), 'open').mockResolvedValue('confirm');
    const deleteButton = [...h.host.querySelectorAll<HTMLButtonElement>('.deps-row__actions button')]
      .find((button) => button.textContent?.trim() === 'Delete')!;
    deleteButton.click();
    await flush(h.fixture);
    expect(h.electron.depsDelete).toHaveBeenCalledWith('llama-server');
    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server removed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('installing');
    h.setList(list('missing'));
    h.deletion.resolve({ ok: true });
    await flush(h.fixture);
    expect(state(h.host)).toBe('missing');
    expect(state(h.host)).not.toBe('success');
  });

  it.each([
    { label: 'a missing status', response: list('missing') },
    { label: 'a fallback catalog warning', response: { ...list('installed'), warning: 'Status unavailable' } },
    { label: 'a failed status query', response: { ok: false, dependencies: [], error: 'Status unavailable' } },
  ])('reports an error when install success is followed by $label', async ({ response }) => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.setList(response);
    h.install.resolve({ ok: true });
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(busy(h.host)).toBe('false');
    expect(h.host.querySelector('.deps-failed')).not.toBeNull();
    expect(h.host.textContent).toContain('could not be verified as installed');
    expect(h.host.textContent).not.toContain('Downloaded llama-server.');
    expect(target(h.host, 'dependencies-llama-progress').textContent).toContain("didn't install");
    expect(target(h.host, 'dependencies-llama-install').textContent).toContain('Retry');
  });

  it('keeps an install error even if a contradictory result and refresh say installed', async () => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.emit({ depId: 'llama-server', phase: 'error', message: 'Network failed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(busy(h.host)).toBe('true');
    h.setList(list('installed'));
    h.install.resolve({ ok: true });
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(busy(h.host)).toBe('false');
    expect(h.host.textContent).toContain('Network failed');
    expect(h.host.textContent).not.toContain('Downloaded llama-server.');
  });

  it('treats a failed status probe as unknown rather than missing or safe to close', async () => {
    const h = setup({ ...list('missing'), warning: 'Status unavailable' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('true');
    expect(h.electron.depsInstall).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
  });

  it('keeps an explicit failed install result even when status still says installed', async () => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.setList(list('installed'));
    h.install.resolve({ ok: false, error: 'Download failed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(h.host.textContent).toContain('Download failed');
    expect(h.host.textContent).not.toContain('Downloaded llama-server.');
  });

  it('surfaces rejected install calls rather than treating an existing binary as success', async () => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.setList(list('installed'));
    h.install.reject(new Error('IPC disconnected'));
    await flush(h.fixture);
    expect(state(h.host)).toBe('error');
    expect(h.host.textContent).toContain('IPC disconnected');
    expect(busy(h.host)).toBe('false');
  });

  it('recovers from a rejected cancellation without completing or leaving the cancel control stuck', async () => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.electron.depsCancel.mockRejectedValueOnce(new Error('Cancel unavailable'));
    const cancel = target(h.host, 'dependencies-llama-progress').querySelector<HTMLButtonElement>('button')!;
    cancel.click();
    await flush(h.fixture);
    expect(state(h.host)).toBe('installing');
    expect(cancel.disabled).toBe(false);
    h.setList(list('installed'));
    h.install.resolve({ ok: true });
    await flush(h.fixture);
    expect(state(h.host)).toBe('success');
    expect(h.electron.depsCancel).toHaveBeenCalledExactlyOnceWith('llama-server');
  });

  it('ignores cleanup done and retains cancellation even if an old install remains', async () => {
    const h = setup();
    await flush(h.fixture);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    target(h.host, 'dependencies-llama-progress').querySelector<HTMLButtonElement>('button')!.click();
    await flush(h.fixture);
    expect(h.electron.depsCancel).toHaveBeenCalledExactlyOnceWith('llama-server');
    h.emit({ depId: 'llama-server', phase: 'cancelling' });
    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server removed' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('installing');
    expect(busy(h.host)).toBe('true');
    expect(h.host.querySelector('.deps-focused')).not.toBeNull();

    h.emit({ depId: 'llama-server', phase: 'cancelled', message: 'Install cancelled; existing install left intact.' });
    await flush(h.fixture);
    expect(state(h.host)).toBe('cancelled');
    expect(busy(h.host)).toBe('true'); // The original IPC action is still resolving.
    h.setList(list('installed'));
    h.install.resolve({ ok: true }); // Even a contradictory result cannot erase the cancellation event.
    await flush(h.fixture);
    expect(state(h.host)).toBe('cancelled');
    expect(busy(h.host)).toBe('false');
    expect(h.host.textContent).not.toContain('Downloaded llama-server.');
  });

  it('recognizes a cancelled reinstall without a progress event even when the old install survives', async () => {
    const h = setup(list('installed'));
    await flush(h.fixture);
    const reinstall = [...h.host.querySelectorAll<HTMLButtonElement>('.deps-row__actions button')]
      .find((button) => button.textContent?.trim() === 'Reinstall')!;
    reinstall.click();
    h.fixture.detectChanges();
    h.reinstall.resolve({ ok: false, cancelled: true });
    await flush(h.fixture);
    expect(state(h.host)).toBe('cancelled');
    expect(busy(h.host)).toBe('false');
    expect(h.host.textContent).not.toContain('Reinstalled llama-server.');
  });

  it.each([
    { latest: 'installed' as const, expected: 'success' },
    { latest: 'missing' as const, expected: 'error' },
  ])('does not let a stale refresh overwrite the later $latest status', async ({ latest, expected }) => {
    const h = setup();
    await flush(h.fixture);
    const stale = deferred<ListResult>();
    const current = deferred<ListResult>();
    h.electron.depsList.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => current.promise);
    click(h.host, 'dependencies-llama-install');
    h.fixture.detectChanges();
    h.install.resolve({ ok: true });
    await flush(h.fixture);
    h.emit({ depId: 'java-lsp', phase: 'done' });
    current.resolve(list(latest));
    await flush(h.fixture);
    // Verification follows the newer request without waiting for the stale IPC to finish.
    expect(state(h.host)).toBe(expected);
    expect(busy(h.host)).toBe('false');
    stale.resolve(list(latest === 'installed' ? 'missing' : 'installed'));
    await flush(h.fixture);
    expect(state(h.host)).toBe(expected);
  });

  it('allows a safe skip while another dependency is downloading without closing or cancelling it', async () => {
    const h = setup(list('installed'));
    await flush(h.fixture);
    const javaRow = [...h.host.querySelectorAll<HTMLElement>('article.deps-row')]
      .find((row) => row.textContent?.includes('Java LSP'))!;
    javaRow.querySelector<HTMLButtonElement>('.deps-row__actions .deps-btn--primary')!.click();
    h.fixture.detectChanges();
    expect(h.electron.depsInstall).toHaveBeenCalledExactlyOnceWith('java-lsp', null);
    expect(h.host.querySelector('.deps-focused')?.textContent).toContain('Java LSP');
    expect(state(h.host)).toBe('installed');
    expect(busy(h.host)).toBe('false');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('true');
    expect(target(h.host, 'dependencies-llama').getAttribute('data-tutorial-llama-visible')).toBe('false');

    h.emit({ depId: 'llama-server', phase: 'done', message: 'llama-server removed' });
    await flush(h.fixture);
    expect(h.host.querySelector('.deps-focused')?.textContent).toContain('Java LSP');
    expect(busy(h.host, 'data-tutorial-dependencies-busy')).toBe('true');
    h.fixture.destroy(); // Dismissing tutorial observation must not control an unrelated download.
    expect(h.electron.depsCancel).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
    expect(h.electron.depsInstall).toHaveBeenCalledTimes(1);
    h.install.resolve({ ok: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
});
