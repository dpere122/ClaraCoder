/**
 * Diagnostic: does the diff viewer render rows after mount under the real
 * zoneless scheduler, without any manual detectChanges()/tick from the test?
 */
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, it, expect, beforeEach } from 'vitest';
import type { DiffRow, FileDiffPayload, HitlTrailArtifact, StagedTransferBatchPayload } from '@shared/index';
import { lucideAppProviders } from '../../../lucide-setup';
import { HitlTrailPanelComponent } from '../../chat/chat-box/hitl-trail-panel/hitl-trail-panel';
import { DiffApplyComponent } from './diff-apply';

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
    TestBed.configureTestingModule({
      imports: [DiffApplyComponent],
      providers: [provideNoopAnimations(), ...lucideAppProviders],
    });
  });

  it('renders virtual rows without a manual tick', async () => {
    const fixture = TestBed.createComponent(DiffApplyComponent);
    fixture.componentRef.setInput('payload', makePayload(40));
    fixture.componentRef.setInput('suppressStagedTransferActions', true);
    fixture.componentRef.setInput('hideExpandButton', true);
    fixture.componentRef.setInput('embeddedInHitlExpand', true);
    fixture.autoDetectChanges();

    // Let CDK's microtask measure + rAF retries run.
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 50));
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const viewports = host.querySelectorAll('cdk-virtual-scroll-viewport');
    const rows = host.querySelectorAll('.diff-vrow');
    // eslint-disable-next-line no-console
    console.log('[repro] viewports:', viewports.length, 'rendered rows:', rows.length);
    expect(viewports.length).toBe(2);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders batch card + diff when artifact arrives after mount (live panel)', async () => {
    const fixture = TestBed.createComponent(HitlTrailPanelComponent);
    fixture.componentRef.setInput('artifacts', [] as HitlTrailArtifact[]);
    fixture.componentRef.setInput('live', true);
    fixture.autoDetectChanges();
    await fixture.whenStable();

    const batch: StagedTransferBatchPayload = {
      version: 1,
      requestId: 'req-1',
      files: [makePayload(30), { ...makePayload(20), relativePath: 'second.md' }],
    };
    // Simulate stream arrival: input set outside any user event.
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
    const rows = host.querySelectorAll('.diff-vrow');
    // eslint-disable-next-line no-console
    console.log('[repro-batch] card:', !!card, 'diffHost:', !!diffHost, 'rows:', rows.length);
    expect(card).toBeTruthy();
    expect(diffHost).toBeTruthy();
    expect(rows.length).toBeGreaterThan(0);
  });
});
