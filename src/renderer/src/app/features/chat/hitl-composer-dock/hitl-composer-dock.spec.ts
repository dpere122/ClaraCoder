import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { HitlTrailArtifact } from '@shared/index';
import { lucideAppProviders } from '../../../lucide-setup';
import { ElectronService } from '../../../core/electron.service';
import { HitlComposerDockComponent } from './hitl-composer-dock';

describe('HitlComposerDockComponent', () => {
  beforeEach(() => {
    if (typeof window.matchMedia !== 'function') {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });
    }
    TestBed.configureTestingModule({
      imports: [HitlComposerDockComponent],
      providers: [
        provideNoopAnimations(),
        ...lucideAppProviders,
        {
          provide: ElectronService,
          useValue: {
            notifyAgentContinue: vi.fn(async () => ({ ok: true })),
          },
        },
      ],
    });
  });

  it('stays closed with no pending artifacts', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    fixture.componentRef.setInput('artifacts', [] as HitlTrailArtifact[]);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.hitl-composer-dock--open')).toBeNull();
  });

  it('opens and renders a pending delete card', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    const artifacts: HitlTrailArtifact[] = [
      {
        role: 'delete_confirm',
        payload: { version: 1, requestId: 'del-1', relativePath: 'a.ts', kind: 'file', recursive: false },
        reviewStatus: 'pending',
      },
    ];
    fixture.componentRef.setInput('artifacts', artifacts);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(true);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.hitl-composer-dock--open')).toBeTruthy();
    expect(host.querySelector('app-delete-confirm')).toBeTruthy();
  });

  it('never docks legacy edit-review cards, even when still pending', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    fixture.componentRef.setInput('artifacts', [
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [{ kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 }],
          fullNewContent: 'x',
          truncated: false,
        },
        reviewStatus: 'pending',
      },
    ] satisfies HitlTrailArtifact[]);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(fixture.componentInstance.pendingArtifacts()).toHaveLength(0);
  });

  it('ignores completed artifacts', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    fixture.componentRef.setInput('artifacts', [
      {
        role: 'delete_confirm',
        payload: { version: 1, requestId: 'del-1', relativePath: 'a.ts' },
        reviewStatus: 'complete',
      },
    ] satisfies HitlTrailArtifact[]);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(fixture.componentInstance.pendingArtifacts()).toHaveLength(0);
  });

  it('names the sub-agent that asked, and keys its card apart from the main agent cards', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    const card = (subagent?: { conversationId: string; name: string }): HitlTrailArtifact => ({
      role: 'delete_confirm',
      payload: {
        version: 1,
        requestId: 'same-id',
        relativePath: 'a.ts',
        kind: 'file',
        recursive: false,
        ...(subagent ? { subagent } : {}),
      },
      reviewStatus: 'pending',
    });
    const artifacts = [card(), card({ conversationId: 'child-1', name: 'Cleaner' })];
    fixture.componentRef.setInput('artifacts', artifacts);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('app-delete-confirm')).toHaveLength(2);
    const badges = host.querySelectorAll('.hitl-composer-dock__subagent');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain('Sub-agent · Cleaner');
    const keys = artifacts.map((a) => fixture.componentInstance.artifactTrackKey(a));
    expect(new Set(keys).size).toBe(2);
  });
});
