import {
  collapseExcessiveAssistantBlankLines,
  gemmaTemplateSanitizeActive,
  isPlaceholderThinkingNoise,
  sanitizeGemmaVisibleAssistantText,
  stripAssistantChannelNoise,
  stripLlmControlMarkers,
  stripPseudoToolCallXml,
} from '@shared/index';

describe('gemmaTemplateSanitizeActive', () => {
  it('is true for gemma preset', () => {
    expect(gemmaTemplateSanitizeActive({ optimizationPreset: 'gemma', model: 'gpt-4o' })).toBe(true);
  });

  it('is true for Gemma model id with generic preset', () => {
    expect(gemmaTemplateSanitizeActive({ optimizationPreset: 'generic', model: 'gemma-4-26b' })).toBe(true);
  });

  it('is false for non-Gemma generic', () => {
    expect(gemmaTemplateSanitizeActive({ optimizationPreset: 'generic', model: 'llama-3' })).toBe(false);
  });
});

describe('stripLlmControlMarkers', () => {
  it('removes <|channel> (single close) and <|channel|> outside fences', () => {
    const input = 'Hello <|channel> world <|channel|> end';
    expect(stripLlmControlMarkers(input)).toBe('Hello  world  end');
  });

  it('removes <|tool_response|> style tags', () => {
    const input = 'Hello <|channel|> world <|tool_response|> end';
    expect(stripLlmControlMarkers(input)).toBe('Hello  world  end');
  });

  it('removes adjacent control spans in one pass', () => {
    expect(stripLlmControlMarkers('a<|x|><|y|>b')).toBe('ab');
  });

  it('removes <turn|> outside fences', () => {
    expect(stripLlmControlMarkers('before<turn|>after')).toBe('beforeafter');
  });

  it('preserves <|foo|> inside fenced code blocks', () => {
    const input = [
      'intro <|strip|> ok',
      '```',
      's = "<|keep|>"',
      '```',
      'outro',
    ].join('\n');
    const got = stripLlmControlMarkers(input);
    expect(got).toContain('<|keep|>');
    expect(got).not.toContain('<|strip|>');
  });

  it('handles tilda fences', () => {
    const input = ['text <|a|>', '~~~', 'x <|b|> y', '~~~'].join('\n');
    expect(stripLlmControlMarkers(input)).toContain('<|b|>');
    expect(stripLlmControlMarkers(input)).not.toContain('<|a|>');
  });
});

describe('collapseExcessiveAssistantBlankLines', () => {
  it('collapses four or more newlines to three', () => {
    expect(collapseExcessiveAssistantBlankLines('a\n\n\n\nb')).toBe('a\n\n\nb');
  });
});

describe('sanitizeGemmaVisibleAssistantText', () => {
  it('strips markers then collapses blank ladders', () => {
    const input = 'Hi <|x|>\n\n\n\n\nBye';
    expect(sanitizeGemmaVisibleAssistantText(input)).toBe('Hi \n\n\nBye');
  });
});

describe('stripPseudoToolCallXml', () => {
  it('removes tool_call blocks', () => {
    expect(stripPseudoToolCallXml('a<tool_call>x</tool_call>b')).toBe('ab');
  });
});

describe('isPlaceholderThinkingNoise', () => {
  it('detects long question-mark walls', () => {
    expect(isPlaceholderThinkingNoise('?'.repeat(40))).toBe(true);
  });

  it('detects long slash walls', () => {
    expect(isPlaceholderThinkingNoise('/'.repeat(40))).toBe(true);
  });

  it('is false for normal prose', () => {
    expect(isPlaceholderThinkingNoise('Explain recursion in plain language.')).toBe(false);
  });

  it('is false for URL-like prose', () => {
    expect(isPlaceholderThinkingNoise('See https://example.com/foo/bar for details.')).toBe(false);
  });
});

describe('stripAssistantChannelNoise', () => {
  it('applies tool xml and control markers', () => {
    expect(stripAssistantChannelNoise('x<tool_call>a</tool_call><|z|>')).toBe('x');
  });

  it('strips Gemma channel tag, 思考过程 heading, and Self-Correction line', () => {
    const raw =
      '<|channel> 思考过程:\n\n1.Analyze.\n\n(Self-Correction: x.)Based on the files, done.';
    expect(stripAssistantChannelNoise(raw)).toBe('1.Analyze.\n\nBased on the files, done.');
  });

  it('drops placeholder question-mark walls', () => {
    expect(stripAssistantChannelNoise('?'.repeat(50))).toBe('');
  });

  it('drops slash filler walls', () => {
    expect(stripAssistantChannelNoise('/'.repeat(50))).toBe('');
  });
});
