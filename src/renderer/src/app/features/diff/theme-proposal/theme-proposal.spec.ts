import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeProposalPayload } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { ThemeProposalComponent } from './theme-proposal';

const payload: ThemeProposalPayload = {
  version: 1,
  requestId: 'theme-abc',
  title: 'Theme proposal: Ocean',
  summary: 'Cool blues.',
  theme: {
    version: 1,
    id: 'ocean',
    name: 'Ocean',
    mode: 'dark',
    tokens: { '--t-primary': '#00aaff', '--t-nope': '#000' },
    groups: {},
  },
  warnings: ['tokens.--t-nope: unknown token (dropped)'],
};

describe('ThemeProposalComponent', () => {
  let electron: {
    config$: Subject<unknown>;
    themeLibrary$: Subject<unknown>;
    themePreview$: Subject<unknown>;
    previewTheme: ReturnType<typeof vi.fn>;
    createTheme: ReturnType<typeof vi.fn>;
    saveTheme: ReturnType<typeof vi.fn>;
    deleteTheme: ReturnType<typeof vi.fn>;
    setTheme: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    electron = {
      config$: new Subject(),
      themeLibrary$: new Subject(),
      themePreview$: new Subject(),
      previewTheme: vi.fn(async () => undefined),
      createTheme: vi.fn(async (p: { name: string; mode: string }) => ({
        ok: true,
        theme: { version: 1, id: 'ocean-2', name: p.name, mode: p.mode, tokens: {}, groups: {} },
      })),
      saveTheme: vi.fn(async (doc: { id: string }) => ({ ok: true, theme: doc })),
      deleteTheme: vi.fn(async () => ({ ok: true })),
      setTheme: vi.fn(async () => ({})),
    };
    TestBed.configureTestingModule({
      imports: [ThemeProposalComponent],
      providers: [{ provide: ElectronService, useValue: electron }],
    });
  });

  function mount() {
    const fixture = TestBed.createComponent(ThemeProposalComponent);
    fixture.componentRef.setInput('payload', payload);
    fixture.detectChanges();
    return fixture;
  }

  it('re-validates the proposal and merges backend + local notes', () => {
    const fixture = mount();
    const cmp = fixture.componentInstance;
    expect(cmp.doc()?.tokens).toEqual({ '--t-primary': '#00aaff' });
    expect(cmp.swatches().length).toBeGreaterThan(0);
    expect(cmp.notes()).toContain('tokens.--t-nope: unknown token (dropped)');
    expect(fixture.nativeElement.textContent).toContain('Theme proposal: Ocean');
    expect(fixture.nativeElement.textContent).toContain('Cool blues.');
  });

  it('preview toggles the cross-window preview and clears it on destroy', async () => {
    const fixture = mount();
    const cmp = fixture.componentInstance;
    await cmp.togglePreview();
    expect(cmp.previewing()).toBe(true);
    expect(electron.previewTheme).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ocean', tokens: { '--t-primary': '#00aaff' } }));
    fixture.destroy();
    expect(electron.previewTheme).toHaveBeenLastCalledWith(null);
  });

  it('save & apply creates a library entry, saves the document under the new id, and activates it', async () => {
    const fixture = mount();
    const cmp = fixture.componentInstance;
    const finished = vi.fn();
    cmp.themeProposalFinished.subscribe(finished);
    await cmp.togglePreview();
    await cmp.save(true);
    expect(electron.createTheme).toHaveBeenCalledWith({ name: 'Ocean', mode: 'dark' });
    expect(electron.saveTheme).toHaveBeenCalledWith(expect.objectContaining({ id: 'ocean-2', name: 'Ocean' }));
    expect(electron.setTheme).toHaveBeenCalledWith('ocean-2');
    expect(electron.previewTheme).toHaveBeenLastCalledWith(null);
    expect(TestBed.inject(ThemeEngineService).findTheme('ocean-2')).toBeTruthy();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'theme-abc', status: 'complete', savedThemeId: 'ocean-2' }),
    );
  });

  it('save only does not activate; a failed save rolls back the created entry', async () => {
    const fixture = mount();
    const cmp = fixture.componentInstance;
    const finished = vi.fn();
    cmp.themeProposalFinished.subscribe(finished);
    await cmp.save(false);
    expect(electron.setTheme).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));

    electron.saveTheme.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    fixture.componentRef.setInput('reviewStatus', 'pending');
    const second = mount().componentInstance;
    await second.save(false);
    expect(second.error()).toContain('disk full');
    expect(electron.deleteTheme).toHaveBeenCalledWith('ocean-2');
  });

  it('dismiss resolves the card as cancelled', async () => {
    const cmp = mount().componentInstance;
    const finished = vi.fn();
    cmp.themeProposalFinished.subscribe(finished);
    await cmp.dismiss();
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'theme-abc', status: 'cancelled' }));
  });
});
