/**
 * Diagnostic: does the diff viewer render after mount under the real
 * zoneless scheduler, without any manual detectChanges()/tick from the test?
 */
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DiffRow, FileDiffPayload, HitlTrailArtifact, StagedTransferBatchPayload } from '@shared/index';
import { lucideAppProviders } from '../../../lucide-setup';
import { HitlComposerDockComponent } from '../../chat/hitl-composer-dock/hitl-composer-dock';
import { DiffApplyComponent } from './diff-apply';

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
    const createModel = vi.fn((_text: string) => ({
      getValue: () => _text,
      setValue: vi.fn(),
      isDisposed: () => false,
      dispose: vi.fn(),
    }));
    return {
      editor: {
        createDiffEditor: vi.fn(() => diffEditor),
        createModel,
        setTheme: vi.fn(),
      },
      Uri: { parse: (u: string) => u },
      __diffEditor: diffEditor,
      __modifiedEditor: modifiedEditor,
    };
  }
  return { makeMonacoMock };
});

vi.mock('monaco-editor', () => makeMonacoMock());

function makePayload(rowCount: number): FileDiffPayload {
  const rows: DiffRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      kind: 'add',
      leftLine: null,
      rightLine: i + 1,
      leftText: '',
      rightText: `line ${i + 1}`,
      hunkIndex: 0,
    });
  }
  return {
    version: 1,
    relativePath: 'repro.md',
    language: 'markdown',
    rows,
    fullNewContent: rows.map((r) => r.rightText).join('\n'),
    truncated: false,
    stagedTransferHitl: true,
  };
}

describe('diff-apply zoneless first paint', () => {
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
    Element.prototype.scrollTo = () => {};
    TestBed.configureTestingModule({
      imports: [DiffApplyComponent],
      providers: [provideNoopAnimations(), ...lucideAppProviders],
    });
  });

  it('renders Monaco host under embeddedInHitlExpand without virtual rows', async () => {
    const fixture = TestBed.createComponent(DiffApplyComponent);
    fixture.componentRef.setInput('payload', makePayload(40));
    fixture.componentRef.setInput('suppressStagedTransferActions', true);
    fixture.componentRef.setInput('hideExpandButton', true);
    fixture.componentRef.setInput('embeddedInHitlExpand', true);
    fixture.autoDetectChanges();

    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const monacoHost = host.querySelector('.diff-monaco-host');
    const viewports = host.querySelectorAll('cdk-virtual-scroll-viewport');
    const rows = host.querySelectorAll('.diff-vrow');
    expect(monacoHost).toBeTruthy();
    expect(viewports.length).toBe(0);
    expect(rows.length).toBe(0);
  });

  it('renders Monaco host when both HITL and batch expand flags are true', async () => {
    const fixture = TestBed.createComponent(DiffApplyComponent);
    fixture.componentRef.setInput('payload', makePayload(40));
    fixture.componentRef.setInput('suppressStagedTransferActions', true);
    fixture.componentRef.setInput('hideExpandButton', true);
    fixture.componentRef.setInput('embeddedInHitlExpand', true);
    fixture.componentRef.setInput('embeddedInBatchExpand', true);
    fixture.autoDetectChanges();

    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const monacoHost = host.querySelector('.diff-monaco-host');
    const viewports = host.querySelectorAll('cdk-virtual-scroll-viewport');
    const rows = host.querySelectorAll('.diff-vrow');
    expect(monacoHost).toBeTruthy();
    expect(viewports.length).toBe(0);
    expect(rows.length).toBe(0);
  });

  it('renders virtual rows when not in HITL expand mode', async () => {
    const fixture = TestBed.createComponent(DiffApplyComponent);
    fixture.componentRef.setInput('payload', makePayload(40));
    fixture.componentRef.setInput('suppressStagedTransferActions', true);
    fixture.componentRef.setInput('hideExpandButton', true);
    fixture.componentRef.setInput('embeddedInHitlExpand', false);
    fixture.autoDetectChanges();

    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const monacoHost = host.querySelector('.diff-monaco-host');
    const viewports = host.querySelectorAll('cdk-virtual-scroll-viewport');
    const rows = host.querySelectorAll('.diff-vrow');
    expect(monacoHost).toBeFalsy();
    expect(viewports.length).toBe(2);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders batch card + Monaco when artifact arrives after mount (composer dock)', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HitlComposerDockComponent],
      providers: [provideNoopAnimations(), ...lucideAppProviders],
    });
    const fixture = TestBed.createComponent(HitlComposerDockComponent);
    fixture.componentRef.setInput('artifacts', [] as HitlTrailArtifact[]);
    fixture.autoDetectChanges();
    await fixture.whenStable();

    const batch: StagedTransferBatchPayload = {
      version: 1,
      requestId: 'req-1',
      files: [makePayload(30), { ...makePayload(20), relativePath: 'second.md' }],
    };
    setTimeout(() => {
      fixture.componentRef.setInput('artifacts', [
        { role: 'staged_transfer_batch', payload: batch, reviewStatus: 'pending' },
      ] satisfies HitlTrailArtifact[]);
    }, 10);

    await new Promise((r) => setTimeout(r, 100));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 100));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const card = host.querySelector('.staged-batch-card');
    const diffHost = host.querySelector('app-diff-apply');
    const monacoHost = host.querySelector('.diff-monaco-host');
    const rows = host.querySelectorAll('.diff-vrow');
    expect(card).toBeTruthy();
    expect(diffHost).toBeTruthy();
    expect(monacoHost).toBeTruthy();
    expect(rows.length).toBe(0);
  });
});
