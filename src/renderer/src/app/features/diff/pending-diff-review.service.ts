import { inject, Injectable, signal } from '@angular/core';
import type { FileDiffPayload, StagedTransferBatchPayload, StagedTransferFileResolution } from '@shared/index';
import { lastUserMessageId } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { ConversationSessionService } from '../shell/conversation-session.service';
import { changeHunkOrderFromRows, rebuildFileWithAcceptedHunks } from './diff-rebuild';

export type DiffReviewFinishedEvent = {
  relativePath: string;
  status: 'complete' | 'cancelled';
  summary?: string;
};

export type StagedTransferBatchFinishedEvent = {
  requestId: string;
  status: 'complete' | 'cancelled';
  summary?: string;
  fileResolutions: Record<string, StagedTransferFileResolution>;
};

export type FlashFn = (message: string, ms: number) => void;
export type FinishFn = (event: DiffReviewFinishedEvent) => void;
export type BatchFinishFn = (event: StagedTransferBatchFinishedEvent) => void;

export type BatchPartialFn = (event: {
  requestId: string;
  fileResolutions: Record<string, StagedTransferFileResolution>;
}) => void;

/** Mutable review state for one pending diff payload (shared by chat + Monaco). */
export interface PendingDiffReviewSession {
  readonly accepted: ReturnType<typeof signal<Set<number>>>;
  readonly skipped: ReturnType<typeof signal<Set<number>>>;
  readonly applying: ReturnType<typeof signal<boolean>>;
  readonly agentContinueSent: ReturnType<typeof signal<boolean>>;
}

export interface PendingStagedTransferBatchSession {
  readonly currentFileIndex: ReturnType<typeof signal<number>>;
  readonly resolutions: ReturnType<typeof signal<Record<string, StagedTransferFileResolution>>>;
  /** Notes sent with a `re_review`, kept per file so the card can show what the agent was told. */
  readonly feedbackByPath: ReturnType<typeof signal<Record<string, string>>>;
  readonly applyingPath: ReturnType<typeof signal<string | null>>;
  readonly agentContinueSent: ReturnType<typeof signal<boolean>>;
}

@Injectable({ providedIn: 'root' })
export class PendingDiffReviewService {
  private readonly electron = inject(ElectronService);
  private readonly conversationSession = inject(ConversationSessionService);
  private readonly sessions = new Map<string, PendingDiffReviewSession>();
  private readonly batchSessions = new Map<string, PendingStagedTransferBatchSession>();

  batchSessionKey(payload: StagedTransferBatchPayload): string {
    return payload.requestId;
  }

  batchSessionFor(payload: StagedTransferBatchPayload): PendingStagedTransferBatchSession {
    const k = this.batchSessionKey(payload);
    let s = this.batchSessions.get(k);
    if (!s) {
      s = {
        currentFileIndex: signal(0),
        resolutions: signal({}),
        feedbackByPath: signal({}),
        applyingPath: signal(null),
        agentContinueSent: signal(false),
      };
      this.batchSessions.set(k, s);
    }
    return s;
  }

  clearBatchSession(payload: StagedTransferBatchPayload): void {
    this.batchSessions.delete(this.batchSessionKey(payload));
  }

  clearAllBatchSessions(): void {
    this.batchSessions.clear();
  }

  nextUnresolvedFileIndex(payload: StagedTransferBatchPayload, resolutions: Record<string, StagedTransferFileResolution>): number {
    const idx = payload.files.findIndex((f) => (resolutions[f.relativePath] ?? 'pending') === 'pending');
    return idx >= 0 ? idx : Math.max(0, payload.files.length - 1);
  }

  /** Stable key so chat and Monaco share state for the same proposal. */
  sessionKey(payload: FileDiffPayload): string {
    return `${payload.relativePath}|${payload.baseSha256 ?? ''}|${payload.rows.length}|${payload.fullNewContent.length}`;
  }

  /** Returns shared session for this payload; resets inner state when the proposal identity changes. */
  sessionFor(payload: FileDiffPayload): PendingDiffReviewSession {
    const k = this.sessionKey(payload);
    let s = this.sessions.get(k);
    if (!s) {
      s = {
        accepted: signal(new Set<number>()),
        skipped: signal(new Set<number>()),
        applying: signal(false),
        agentContinueSent: signal(false),
      };
      this.sessions.set(k, s);
    }
    return s;
  }

  /** Drop session after review completes so a future proposal with the same path gets fresh sets. */
  clearSession(payload: FileDiffPayload): void {
    this.sessions.delete(this.sessionKey(payload));
  }

  /** Clears all in-flight review UI state (e.g. when switching conversations). */
  clearAllSessions(): void {
    this.sessions.clear();
    this.batchSessions.clear();
  }

  incrementalOk(payload: FileDiffPayload): boolean {
    if (payload.stagedTransferHitl) {
      return false;
    }
    return !payload.truncated && payload.rows.length > 0;
  }

  changeHunkOrder(payload: FileDiffPayload): number[] {
    return changeHunkOrderFromRows(payload.rows);
  }

  currentFocusHunk(
    payload: FileDiffPayload,
    accepted: ReadonlySet<number>,
    skipped: ReadonlySet<number>,
  ): number | null {
    const order = this.changeHunkOrder(payload);
    const next = order.find((h) => !accepted.has(h) && !skipped.has(h));
    return next ?? null;
  }

  /** Write file content; flashes standard errors (matches legacy diff-apply behavior). */
  async writeWorkspaceContent(
    payload: FileDiffPayload,
    content: string,
    flashMessage: FlashFn,
  ): Promise<boolean> {
    const ws = await this.electron.getCurrentWorkspace();
    if (!ws?.path) {
      flashMessage('No workspace open.', 3000);
      return false;
    }
    const encoding = payload.diskEncoding ?? 'utf-8';
    const newline = payload.diskNewline === 'crlf' ? 'crlf' : 'lf';
    const res = await this.electron.writeWorkspaceFile(ws.path, payload.relativePath, content, {
      encoding,
      newline,
    });
    if (!res.ok) {
      flashMessage(res.error ?? 'Write failed.', 4000);
      return false;
    }
    const conversationId = this.conversationSession.activeConversationId();
    const userMessageId = lastUserMessageId(this.conversationSession.messages());
    if (conversationId && userMessageId) {
      const created = typeof payload.fullOriginalContent !== 'string';
      void this.electron.appendConversationFileJournal({
        conversationId,
        userMessageId,
        op: created ? 'create' : 'modify',
        relativePath: payload.relativePath,
        beforeContent: created ? null : payload.fullOriginalContent,
        beforeEncoding: encoding,
        beforeNewline: newline,
      });
    }
    return true;
  }

  private async resumeAgent(
    conversationId: string | null,
    note: string,
    flashMessage: FlashFn,
    stagedTransferAction?: 'confirm' | 're_review',
    stagedTransferRequestId?: string,
    stagedTransferPath?: string,
  ): Promise<{ ok: boolean; batchComplete?: boolean }> {
    if (!conversationId?.trim()) {
      flashMessage('No conversation id.', 3000);
      return { ok: false };
    }
    const res = await this.electron.notifyAgentContinue(
      conversationId,
      note,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stagedTransferAction,
      stagedTransferRequestId,
      stagedTransferPath,
    );
    if (!res.ok) {
      flashMessage(res.error ?? 'Could not resume assistant.', 5000);
      return { ok: false };
    }
    return { ok: true, batchComplete: res.batchComplete !== false };
  }

  private async finishReview(
    payload: FileDiffPayload,
    conversationId: string | null,
    session: PendingDiffReviewSession,
    status: 'complete' | 'cancelled',
    summary: string,
    note: string,
    stagedTransferAction: 'confirm' | 're_review' | undefined,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    if (session.agentContinueSent()) {
      return;
    }
    session.agentContinueSent.set(true);
    const res = await this.resumeAgent(conversationId, note, flashMessage, stagedTransferAction);
    if (!res.ok) {
      session.agentContinueSent.set(false);
      return;
    }
    this.clearSession(payload);
    onFinished({
      relativePath: payload.relativePath,
      status,
      summary,
    });
  }

  private async maybeCompleteReview(
    payload: FileDiffPayload,
    conversationId: string | null,
    session: PendingDiffReviewSession,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    if (session.agentContinueSent()) {
      return;
    }
    const order = this.changeHunkOrder(payload);
    const acc = session.accepted();
    const sk = session.skipped();
    if (!order.every((h) => acc.has(h) || sk.has(h))) {
      return;
    }

    const path = payload.relativePath;
    const allSkipped = order.length > 0 && order.every((h) => sk.has(h));

    let msg: string;
    let summary: string;
    if (allSkipped) {
      summary = 'All changes skipped';
      msg = [
        'The user skipped all proposed edits for file',
        `\`${path}\`.`,
        'Please continue from here.',
      ].join(' ');
    } else {
      summary = 'Complete';
      msg = [
        'I finished reviewing the proposed edit for file',
        `\`${path}\`.`,
        'The workspace file on disk reflects the accepted changes. Please continue from here.',
      ].join(' ');
    }
    flashMessage('Review complete. Resuming assistant…', 3500);
    await this.finishReview(payload, conversationId, session, 'complete', summary, msg, undefined, flashMessage, onFinished);
  }

  async acceptCurrentChange(
    payload: FileDiffPayload,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying()) {
      return;
    }
    const order = this.changeHunkOrder(payload);
    const focus = this.currentFocusHunk(payload, session.accepted(), session.skipped());
    if (!this.incrementalOk(payload) || focus == null) {
      await this.applyAllAtOnce(payload, conversationId, flashMessage, onFinished);
      return;
    }

    session.applying.set(true);
    try {
      const next = new Set(session.accepted());
      next.add(focus);
      const body = rebuildFileWithAcceptedHunks(payload.rows, next);
      const ok = await this.writeWorkspaceContent(payload, body, flashMessage);
      if (!ok) {
        return;
      }

      session.accepted.set(next);

      const sk = session.skipped();
      const allResolved = order.every((h) => next.has(h) || sk.has(h));
      if (allResolved) {
        const allSk = order.every((h) => sk.has(h));
        if (!allSk && body !== payload.fullNewContent) {
          const fix = await this.writeWorkspaceContent(payload, payload.fullNewContent, flashMessage);
          if (!fix) {
            return;
          }
        }
        await this.maybeCompleteReview(payload, conversationId, session, flashMessage, onFinished);
      } else {
        flashMessage('Saved. Next change highlighted.', 2200);
      }
    } finally {
      session.applying.set(false);
    }
  }

  async skipCurrentChange(
    payload: FileDiffPayload,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying()) {
      return;
    }
    const order = this.changeHunkOrder(payload);
    const focus = this.currentFocusHunk(payload, session.accepted(), session.skipped());
    if (!this.incrementalOk(payload) || focus == null) {
      return;
    }

    session.applying.set(true);
    try {
      const sk = new Set(session.skipped());
      sk.add(focus);
      session.skipped.set(sk);

      const acc = session.accepted();
      const body = rebuildFileWithAcceptedHunks(payload.rows, acc);
      const ok = await this.writeWorkspaceContent(payload, body, flashMessage);
      if (!ok) {
        sk.delete(focus);
        session.skipped.set(sk);
        return;
      }

      const allResolved = order.every((h) => acc.has(h) || sk.has(h));
      if (allResolved) {
        const allSk = order.every((h) => sk.has(h));
        if (!allSk && body !== payload.fullNewContent) {
          const fix = await this.writeWorkspaceContent(payload, payload.fullNewContent, flashMessage);
          if (!fix) {
            return;
          }
        }
        await this.maybeCompleteReview(payload, conversationId, session, flashMessage, onFinished);
      } else {
        flashMessage('Skipped. Next change highlighted.', 2200);
      }
    } finally {
      session.applying.set(false);
    }
  }

  async approveStagedTransferHitl(
    payload: FileDiffPayload,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying() || session.agentContinueSent()) {
      return;
    }
    session.applying.set(true);
    try {
      flashMessage('Approving workspace transfer…', 3500);
      await this.finishReview(
        payload,
        conversationId,
        session,
        'complete',
        'Workspace transfer approved',
        '',
        'confirm',
        flashMessage,
        onFinished,
      );
    } finally {
      session.applying.set(false);
    }
  }

  async returnStagedTransferForReReview(
    payload: FileDiffPayload,
    conversationId: string | null,
    feedback: string,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying() || session.agentContinueSent()) {
      return;
    }
    session.applying.set(true);
    try {
      const fb = feedback.trim();
      flashMessage('Returning for re-review…', 3500);
      await this.finishReview(
        payload,
        conversationId,
        session,
        'cancelled',
        'Returned for re-review',
        fb || '(no details)',
        're_review',
        flashMessage,
        onFinished,
      );
    } finally {
      session.applying.set(false);
    }
  }

  async applyAllAtOnce(
    payload: FileDiffPayload,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying()) {
      return;
    }
    if (payload.stagedTransferHitl) {
      await this.approveStagedTransferHitl(payload, conversationId, flashMessage, onFinished);
      return;
    }
    session.applying.set(true);
    try {
      const ok = await this.writeWorkspaceContent(payload, payload.fullNewContent, flashMessage);
      if (!ok) {
        return;
      }
      const order = this.changeHunkOrder(payload);
      session.accepted.set(new Set(order));
      session.skipped.set(new Set());
      await this.maybeCompleteReview(payload, conversationId, session, flashMessage, onFinished);
    } finally {
      session.applying.set(false);
    }
  }

  async resolveStagedTransferBatchFile(
    payload: StagedTransferBatchPayload,
    relativePath: string,
    action: 'confirm' | 're_review',
    feedback: string,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: BatchFinishFn,
    onPartialResolved?: BatchPartialFn,
  ): Promise<void> {
    const session = this.batchSessionFor(payload);
    const resolutions = session.resolutions();
    if ((resolutions[relativePath] ?? 'pending') !== 'pending') {
      return;
    }
    if (session.applyingPath() || session.agentContinueSent()) {
      return;
    }
    session.applyingPath.set(relativePath);
    try {
      const note = action === 're_review' ? feedback.trim() || '(no details)' : '';
      const res = await this.resumeAgent(
        conversationId,
        note,
        flashMessage,
        action,
        payload.requestId,
        relativePath,
      );
      if (!res.ok) {
        return;
      }
      const nextRes: Record<string, StagedTransferFileResolution> = {
        ...session.resolutions(),
        [relativePath]: action === 'confirm' ? 'approved' : 're_review',
      };
      session.resolutions.set(nextRes);
      if (action === 're_review') {
        session.feedbackByPath.update((prev) => ({ ...prev, [relativePath]: feedback.trim() }));
      }
      if (res.batchComplete) {
        session.agentContinueSent.set(true);
        flashMessage('Batch transfer review complete. Resuming assistant…', 3500);
        this.clearBatchSession(payload);
        const anyReReview = Object.values(nextRes).some((v) => v === 're_review');
        onFinished({
          requestId: payload.requestId,
          status: anyReReview ? 'cancelled' : 'complete',
          summary: anyReReview ? 'Some files returned for re-review' : 'All transfers approved',
          fileResolutions: nextRes,
        });
        return;
      }
      onPartialResolved?.({
        requestId: payload.requestId,
        fileResolutions: nextRes,
      });
      const nextIdx = this.nextUnresolvedFileIndex(payload, nextRes);
      session.currentFileIndex.set(nextIdx);
      flashMessage(
        action === 'confirm' ? 'Transfer approved for this file.' : 'Returned for re-review.',
        2500,
      );
    } finally {
      session.applyingPath.set(null);
    }
  }

  async cancelProposal(
    payload: FileDiffPayload,
    conversationId: string | null,
    flashMessage: FlashFn,
    onFinished: FinishFn,
  ): Promise<void> {
    const session = this.sessionFor(payload);
    if (session.applying() || session.agentContinueSent()) {
      return;
    }
    if (payload.stagedTransferHitl) {
      flashMessage('Returning for re-review…', 3500);
      await this.finishReview(
        payload,
        conversationId,
        session,
        'cancelled',
        'Returned for re-review',
        '(user dismissed the transfer card without approving)',
        're_review',
        flashMessage,
        onFinished,
      );
      return;
    }
    const path = payload.relativePath;
    const msg = [
      'The user cancelled applying the proposed edits for file',
      `\`${path}\`.`,
      'Those edits were not applied. Please continue from here.',
    ].join(' ');
    flashMessage('Cancelled. Resuming assistant…', 3500);
    await this.finishReview(
      payload,
      conversationId,
      session,
      'cancelled',
      'Cancelled',
      msg,
      undefined,
      flashMessage,
      onFinished,
    );
  }
}
