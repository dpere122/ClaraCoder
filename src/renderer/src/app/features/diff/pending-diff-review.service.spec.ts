import { TestBed } from '@angular/core/testing';
import type { FileDiffPayload } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { PendingDiffReviewService } from './pending-diff-review.service';

function minimalDiffPayload(overrides: Partial<FileDiffPayload> = {}): FileDiffPayload {
  return {
    version: 1,
    relativePath: 'src/a.ts',
    language: 'typescript',
    rows: [],
    fullNewContent: '',
    truncated: false,
    ...overrides,
  };
}

describe('PendingDiffReviewService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        PendingDiffReviewService,
        {
          provide: ElectronService,
          useValue: {
            getCurrentWorkspace: async () => ({ path: '/w', id: 'w1', name: 'W' }),
            writeWorkspaceFile: async () => ({ ok: true }),
            notifyAgentContinue: async () => ({ ok: true }),
          },
        },
      ],
    });
  });

  it('clearAllSessions removes cached review state', () => {
    const svc = TestBed.inject(PendingDiffReviewService);
    const p = minimalDiffPayload({
      rows: [{ kind: 'equal', leftLine: 1, rightLine: 1, leftText: '', rightText: '', hunkIndex: 0 }],
    });
    const s1 = svc.sessionFor(p);
    s1.accepted.update((x) => new Set(x).add(0));
    expect(s1.accepted().has(0)).toBe(true);

    svc.clearAllSessions();

    const s2 = svc.sessionFor(p);
    expect(s2.accepted().has(0)).toBe(false);
  });
});
