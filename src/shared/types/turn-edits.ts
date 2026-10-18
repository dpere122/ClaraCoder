import type { ConversationFileJournalOp } from './conversation-timeline';

/** Whether a turn's edit to one path is still on disk or was reset to its pre-edit state. */
export type TurnEditedFileStatus = 'kept' | 'reset';

/** One path the agent wrote during a user turn (persisted on the assistant message). */
export interface TurnEditedFile {
  relativePath: string;
  op: ConversationFileJournalOp;
  additions: number;
  deletions: number;
  status: TurnEditedFileStatus;
}

/** `list-turn-files` row: {@link TurnEditedFile} plus a live disk check. */
export interface TurnEditedFileRow extends TurnEditedFile {
  /** True when disk no longer matches what the turn left (edited later or by hand). */
  changedSinceTurn: boolean;
}

export type TurnFileDiffResult =
  | {
      ok: true;
      relativePath: string;
      op: ConversationFileJournalOp;
      /** Text before the turn's first write ('' when the file did not exist). */
      before: string;
      /** Text the turn left on disk ('' when the turn deleted the file). */
      after: string;
      beforeExisted: boolean;
      afterExists: boolean;
    }
  | { ok: false; error: string };

export interface ResetTurnFilesRequest {
  conversationId: string;
  userMessageId: string;
  /** Paths to reset; omit for every still-kept path of the turn. */
  paths?: string[];
  /** Overwrite paths whose disk content changed since the turn. */
  force?: boolean;
}

export type ResetTurnFilesResult =
  | {
      ok: true;
      resetPaths: string[];
      skippedPaths: string[];
      /** Updated summaries for the whole turn (mirror into `editedFiles`). */
      files: TurnEditedFile[];
    }
  | {
      ok: false;
      /** Paths changed on disk since the turn; retry with `force` to overwrite. */
      conflicts?: string[];
      error: string;
    };
