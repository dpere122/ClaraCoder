import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { HitlTrailArtifact } from '@shared/index';
import { lucideAppProviders } from '../../../lucide-setup';
import { ElectronService } from '../../../core/electron.service';
import type { ChatMessage } from '../chat-box/chat-box';
import { ConversationSessionService } from '../../shell/conversation-session.service';
import { HitlComposerDockComponent } from './hitl-composer-dock';

// The pending diff card mounts `app-diff-monaco-preview`, which dynamically imports Monaco.
// Under the parallel suite that real import can resolve after this file's environment is torn
// down (EnvironmentTeardownError). Stub the module: these tests only assert dock behaviour.
const { makeMonacoMock } = vi.hoisted(() => {
  function makeMonacoMock() {
    const modifiedEditor = { revealLineInCenter: vi.fn() };
    const diffEditor = {
      setModel: vi.fn(),
      updateOptions: vi.fn(),
      layout: vi.fn(),
      getModifiedEditor: () => modifiedEditor,
      dispose: vi.fn(),
    };
    return {
      editor: {
        createDiffEditor: vi.fn(() => diffEditor),
        createModel: vi.fn((text: string) => ({ getValue: () => text, setValue: vi.fn(), isDisposed: () => false, dispose: vi.fn() })),
        defineTheme: vi.fn(),
        setTheme: vi.fn(),
      },
      Uri: { parse: (u: string) => u },
    };
  }
  return { makeMonacoMock };
});

vi.mock('monaco-editor', () => makeMonacoMock());

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
        {
          // app-diff-apply -> PendingDiffReviewService reads these two signals.
          provide: ConversationSessionService,
          useValue: {
            activeConversationId: signal<string | null>(null),
            messages: signal<ChatMessage[]>([]),
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

  it('opens and renders a pending diff card', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    const artifacts: HitlTrailArtifact[] = [
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
    ];
    fixture.componentRef.setInput('artifacts', artifacts);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(true);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.hitl-composer-dock--open')).toBeTruthy();
    expect(host.querySelector('app-diff-apply')).toBeTruthy();
  });

  it('ignores completed artifacts', () => {
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    fixture.componentRef.setInput('artifacts', [
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
    ] satisfies HitlTrailArtifact[]);
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(fixture.componentInstance.pendingArtifacts()).toHaveLength(0);
  });
});
