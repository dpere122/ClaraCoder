/** Payload for SSE `agent_question` / plan-mode clarifying-questions HITL card. */

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  id: string;
  prompt: string;
  options: QuestionOption[];
  /** When true (default) the UI appends an "Other" free-text choice as the last option. */
  allowOther: boolean;
}

export interface AgentQuestionPayload {
  version: 1;
  requestId: string;
  title: string;
  message: string;
  submitLabel: string;
  cancelLabel: string;
  questions: QuestionPrompt[];
  /** Build plan id linked to the preview tab. */
  planId?: string;
  /** Workspace-relative path to the build plan markdown file (preview tab). */
  buildPlanPath?: string;
}

/** One answer in the resolved question-card response. Either optionId or otherText is set. */
export interface QuestionAnswer {
  questionId: string;
  optionId?: string;
  otherText?: string;
}
