import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDependencyCatalog, type AppConfig, type DependencyInfo } from '@shared/index';
import type { ElectronService as ElectronServiceType } from '../../../core/electron.service';
import type { Dependencies as DependenciesComponent } from './dependencies';

let ElectronService!: typeof ElectronServiceType;
let Dependencies!: typeof DependenciesComponent;

function setup(state: DependencyInfo['state'], config?: Promise<AppConfig>) {
  const llama = defaultDependencyCatalog().find((dep) => dep.id === 'llama-server')!;
  const electron = {
    config$: new Subject<AppConfig>(),
    loadConfig: vi.fn(() => config ?? Promise.resolve({ uiFontSizeRem: 1, uiFontFamily: '', codeFontFamily: '' } as AppConfig)),
    depsList: vi.fn(async () => ({ ok: true, dependencies: [{ ...llama, state }] })),
    depsInstall: vi.fn(async () => ({ ok: false, error: 'Download failed' })),
    depsReinstall: vi.fn(async () => ({ ok: false, error: 'Reinstall failed' })),
    depsDelete: vi.fn(),
    depsCancel: vi.fn(),
    closeDependenciesWindow: vi.fn(),
    onDepsProgress: vi.fn(() => () => {}),
  };
  const spinner = { getSpinner: () => NEVER, show: vi.fn(), hide: vi.fn() };
  TestBed.configureTestingModule({
    imports: [Dependencies],
    providers: [
      { provide: ElectronService, useValue: electron },
      { provide: NgxSpinnerService, useValue: spinner },
    ],
  });
  const fixture = TestBed.createComponent(Dependencies);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, electron, spinner };
}

async function flush(fixture: ComponentFixture<DependenciesComponent>): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  fixture.detectChanges();
  await Promise.resolve();
}

beforeAll(async () => {
  // Keep provider tokens and the component in the same module graph as other lazy-loaded suites.
  vi.resetModules();
  await import('@shared/index');
  ({ ElectronService } = await import('../../../core/electron.service'));
  ({ Dependencies } = await import('./dependencies'));
});

beforeEach(() => {
  TestBed.resetTestingModule();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('llama-server tutorial retry target', () => {
  it('targets Retry after a failed download and never starts it without a click', async () => {
    const h = setup('missing');
    await flush(h.fixture);
    const download = h.host.querySelector<HTMLButtonElement>('[data-tutorial="dependencies-llama-install"]')!;
    expect(download.textContent).toContain('Download');
    expect(h.electron.depsInstall).not.toHaveBeenCalled();

    download.click();
    await flush(h.fixture);
    const retry = h.host.querySelector<HTMLButtonElement>('[data-tutorial="dependencies-llama-install"]')!;
    expect(retry.textContent?.trim()).toBe('Retry');
    expect(h.electron.depsInstall).toHaveBeenCalledTimes(1);
    expect(h.electron.depsReinstall).not.toHaveBeenCalled();
    expect(h.electron.depsDelete).not.toHaveBeenCalled();
    expect(h.electron.depsCancel).not.toHaveBeenCalled();
    h.fixture.destroy();
  });

  it('labels a reinstall retry explicitly and does not present it as the download target', async () => {
    const h = setup('installed');
    await flush(h.fixture);
    const reinstall = [...h.host.querySelectorAll<HTMLButtonElement>('.deps-row__actions button')]
      .find((button) => button.textContent?.trim() === 'Reinstall')!;
    expect(h.electron.depsReinstall).not.toHaveBeenCalled();
    reinstall.click();
    await flush(h.fixture);

    const failure = h.host.querySelector<HTMLElement>('[data-tutorial="dependencies-llama-progress"]')!;
    const retry = [...failure.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry reinstall')!;
    expect(retry).toBeDefined();
    expect(retry.hasAttribute('data-tutorial')).toBe(false);
    expect(h.host.querySelector('[data-tutorial="dependencies-llama-install"]')).toBeNull();
    expect(h.electron.depsReinstall).toHaveBeenCalledTimes(1);
    expect(h.electron.depsInstall).not.toHaveBeenCalled();
    expect(h.electron.depsDelete).not.toHaveBeenCalled();

    retry.click();
    await flush(h.fixture);
    expect(h.electron.depsReinstall).toHaveBeenCalledTimes(2);
    expect(h.electron.depsInstall).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
    h.fixture.destroy();
  });
});

describe('Dependencies initialization', () => {
  it('shows dependency status while appearance config is pending and preserves a newer config broadcast', async () => {
    let resolveConfig!: (config: AppConfig) => void;
    const config = new Promise<AppConfig>((resolve) => { resolveConfig = resolve; });
    const previousStyle = document.documentElement.style.cssText;
    const h = setup('missing', config);
    await flush(h.fixture);
    expect(h.electron.depsList).toHaveBeenCalledOnce();
    expect(h.host.querySelector('[data-tutorial="dependencies-llama"]')?.getAttribute('data-tutorial-llama-state')).toBe('missing');
    expect(h.electron.depsInstall).not.toHaveBeenCalled();

    h.electron.config$.next({ uiFontSizeRem: 1, uiFontFamily: 'Newest Font', codeFontFamily: '' } as AppConfig);
    resolveConfig({ uiFontSizeRem: 1, uiFontFamily: 'Stale Font', codeFontFamily: '' } as AppConfig);
    await flush(h.fixture);
    expect(document.documentElement.style.getPropertyValue('--t-font-ui-override')).toBe('Newest Font');
    h.fixture.destroy();
    document.documentElement.style.cssText = previousStyle;
  });

  it('still loads dependency status if appearance config fails', async () => {
    const h = setup('missing', Promise.reject(new Error('Config unavailable')));
    await flush(h.fixture);
    expect(h.electron.depsList).toHaveBeenCalledOnce();
    expect(h.host.querySelector('[data-tutorial="dependencies-llama"]')?.getAttribute('data-tutorial-llama-state')).toBe('missing');
    expect(h.electron.depsInstall).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
    h.fixture.destroy();
  });

  it('ignores a late config response and unsubscribes after the window closes', async () => {
    let resolveConfig!: (config: AppConfig) => void;
    const config = new Promise<AppConfig>((resolve) => { resolveConfig = resolve; });
    const previousStyle = document.documentElement.style.cssText;
    const h = setup('installed', config);
    await flush(h.fixture);
    h.fixture.destroy();
    document.documentElement.style.setProperty('--t-font-ui-override', 'Unchanged');
    resolveConfig({ uiFontSizeRem: 1, uiFontFamily: 'Late Font', codeFontFamily: '' } as AppConfig);
    h.electron.config$.next({ uiFontSizeRem: 1, uiFontFamily: 'After close', codeFontFamily: '' } as AppConfig);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(document.documentElement.style.getPropertyValue('--t-font-ui-override')).toBe('Unchanged');
    expect(h.electron.depsCancel).not.toHaveBeenCalled();
    expect(h.electron.closeDependenciesWindow).not.toHaveBeenCalled();
    document.documentElement.style.cssText = previousStyle;
  });

  it('does not start queued config or spinner work after immediate teardown', async () => {
    const h = setup('missing');
    h.fixture.destroy();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.electron.loadConfig).not.toHaveBeenCalled();
    expect(h.spinner.show).not.toHaveBeenCalled();
    expect(h.spinner.hide).toHaveBeenCalledWith('deps-list-spinner');
    expect(h.electron.depsCancel).not.toHaveBeenCalled();
  });
});
