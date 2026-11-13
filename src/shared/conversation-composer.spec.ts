import { describe, expect, it } from 'vitest';
import {
  activeConversationModel,
  DEFAULT_CONVERSATION_COMPOSER,
  newConversationComposer,
  normalizeConversationComposer,
  sameConversationComposer,
  sameConversationModel,
  type ConversationComposerState,
} from './conversation-composer';

const FULL: ConversationComposerState = {
  draft: 'a draft',
  mode: 'plan',
  autoApply: true,
  admin: true,
  thinkingMode: 'off',
  reasoningEffort: 'high',
};

describe('normalizeConversationComposer', () => {
  it('keeps a stored composer as it is', () => {
    expect(normalizeConversationComposer(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });

  it('is null for nothing stored', () => {
    expect(normalizeConversationComposer(null)).toBeNull();
    expect(normalizeConversationComposer('plan')).toBeNull();
    expect(normalizeConversationComposer([])).toBeNull();
  });

  it('falls back to defaults field by field, and leaves out thinking it does not know', () => {
    expect(
      normalizeConversationComposer({ draft: 3, mode: 'yolo', autoApply: 'yes', admin: 1, thinkingMode: 'max', reasoningEffort: 'turbo' }),
    ).toEqual(DEFAULT_CONVERSATION_COMPOSER);
  });

  it('never has Auto Run on in Ask mode', () => {
    expect(normalizeConversationComposer({ ...FULL, mode: 'ask' })?.autoApply).toBe(false);
  });

  it('keeps Default as an explicit reasoning level', () => {
    expect(normalizeConversationComposer({ ...FULL, reasoningEffort: '' })?.reasoningEffort).toBe('');
  });
});

describe('newConversationComposer', () => {
  it('carries the mode, Auto Run and thinking over, with an empty draft and Admin off', () => {
    expect(newConversationComposer(FULL)).toEqual({
      draft: '',
      mode: 'plan',
      autoApply: true,
      admin: false,
      thinkingMode: 'off',
      reasoningEffort: 'high',
    });
  });

  it('starts from the defaults with nothing to carry over, leaving thinking to the source', () => {
    const fresh = newConversationComposer(null);
    expect(fresh).toEqual(DEFAULT_CONVERSATION_COMPOSER);
    expect('thinkingMode' in fresh).toBe(false);
  });
});

describe('sameConversationComposer', () => {
  it('compares every field', () => {
    expect(sameConversationComposer(FULL, { ...FULL })).toBe(true);
    expect(sameConversationComposer(FULL, { ...FULL, draft: 'b' })).toBe(false);
    expect(sameConversationComposer(FULL, { ...FULL, reasoningEffort: undefined })).toBe(false);
  });
});

describe('the model a conversation is on', () => {
  it('is kept, with the Claude model only alongside a model id', () => {
    expect(normalizeConversationComposer({ ...FULL, modelId: ' m1 ', claudeModel: 'claude-opus' })).toMatchObject({
      modelId: 'm1',
      claudeModel: 'claude-opus',
    });
    expect(normalizeConversationComposer({ ...FULL, claudeModel: 'claude-opus' })).not.toHaveProperty('claudeModel');
    expect(normalizeConversationComposer({ ...FULL, modelId: 'x'.repeat(201) })).not.toHaveProperty('modelId');
  });

  it('carries over to a new conversation', () => {
    expect(newConversationComposer({ ...FULL, modelId: 'm1', claudeModel: 'claude-opus' })).toMatchObject({
      modelId: 'm1',
      claudeModel: 'claude-opus',
    });
  });

  it('is read from the app: the active model, and which Claude model on the Claude source', () => {
    const providers = [
      { id: 'local', provider: 'llamacpp', models: [{ id: 'm1', model: 'gemma' }] },
      { id: 'claude', provider: 'anthropic', models: [{ id: 'm2', model: 'claude-opus' }] },
    ] as unknown as Parameters<typeof activeConversationModel>[0]['llmProviders'];
    expect(activeConversationModel({ activeLlmModelId: 'm1', llmProviders: providers })).toEqual({ modelId: 'm1' });
    expect(activeConversationModel({ activeLlmModelId: 'm2', llmProviders: providers })).toEqual({
      modelId: 'm2',
      claudeModel: 'claude-opus',
    });
    expect(sameConversationModel({ modelId: 'm2', claudeModel: 'claude-opus' }, { modelId: 'm2' })).toBe(false);
  });
});
