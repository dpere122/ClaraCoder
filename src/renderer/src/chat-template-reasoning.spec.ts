import { describe, expect, it } from 'vitest';
import {
  GENERIC_REASONING_EFFORT_VALUES,
  LLM_REASONING_EFFORT_OPTIONS,
  LLM_THINKING_MODE_OPTIONS,
  formatChatTemplateReasoningSummary,
  llmComposerEffortOptions,
  llmComposerEffortValue,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  parseChatTemplateReasoning,
  parseLlamaServerPropsNctx,
  parseLlamaServerPropsReasoning,
} from '@shared/index';

const QWEN3_ENABLE_THINKING = `
{%- if enable_thinking is defined and enable_thinking is false %}
    {{- '<think>\\n\\n</think>\\n\\n' }}
{%- else %}
    {{- '<think>\\n' }}
{%- endif %}
`;

const QWEN38_EFFORT_LIST = `
{%- if reasoning_effort not in ["xhigh", "medium", "low"] %}
    {%- set reasoning_effort = "medium" %}
{%- endif %}
{{- reasoning_effort }}
`;

const QWEN38_BOTH = `
{%- if enable_thinking is defined and enable_thinking is false %}
    {{- '<think></think>' }}
{%- elif reasoning_effort not in ['xhigh', 'medium', 'low'] %}
    {%- raise_exception('Unexpected reasoning effort') %}
{%- endif %}
`;

/** Official Qwen3.8 chat_template.jinja uses a parenthesized tuple, not ``[…]``. */
const QWEN38_OFFICIAL_TUPLE = `
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
{%- endif %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\\n\\n</think>\\n\\n' }}
    {%- else %}
        {{- '<think>\\n' }}
    {%- endif %}
{%- endif %}
`;

const GEMMA_ENABLE_THINKING = `
{%- set enable_thinking = enable_thinking | default(true) -%}
{%- if enable_thinking %}
    {{- '<|channel>thought\\n' }}
{%- endif %}
`;

const PLAIN_CHATML = `
{% for message in messages %}
  {{ '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' }}
{% endfor %}
`;

describe('parseChatTemplateReasoning', () => {
  it('detects Qwen3 enable_thinking only', () => {
    expect(parseChatTemplateReasoning(QWEN3_ENABLE_THINKING)).toEqual({
      enableThinking: true,
      reasoningEffortValues: null,
    });
  });

  it('extracts a Qwen3.8 reasoning_effort allow-list', () => {
    expect(parseChatTemplateReasoning(QWEN38_EFFORT_LIST)).toEqual({
      enableThinking: false,
      reasoningEffortValues: ['xhigh', 'medium', 'low'],
    });
  });

  it('detects both knobs when the template has enable_thinking and an effort list', () => {
    expect(parseChatTemplateReasoning(QWEN38_BOTH)).toEqual({
      enableThinking: true,
      reasoningEffortValues: ['xhigh', 'medium', 'low'],
    });
  });

  it('extracts the official Qwen3.8 parenthesized tuple allow-list', () => {
    expect(parseChatTemplateReasoning(QWEN38_OFFICIAL_TUPLE)).toEqual({
      enableThinking: true,
      reasoningEffortValues: ['xhigh', 'medium', 'low'],
    });
  });

  it('detects Gemma enable_thinking', () => {
    expect(parseChatTemplateReasoning(GEMMA_ENABLE_THINKING)).toEqual({
      enableThinking: true,
      reasoningEffortValues: null,
    });
  });

  it('returns neither for a plain ChatML template', () => {
    expect(parseChatTemplateReasoning(PLAIN_CHATML)).toEqual({
      enableThinking: false,
      reasoningEffortValues: null,
    });
  });

  it('ignores identifiers outside Jinja chunks', () => {
    const raw = 'docs: pass enable_thinking and reasoning_effort via kwargs\n{% for m in messages %}{{ m.content }}{% endfor %}';
    expect(parseChatTemplateReasoning(raw)).toEqual({
      enableThinking: false,
      reasoningEffortValues: null,
    });
  });

  it('uses the generic effort list when reasoning_effort is present without an allow-list', () => {
    const tpl = '{% if reasoning_effort %}{{ reasoning_effort }}{% endif %}';
    expect(parseChatTemplateReasoning(tpl).reasoningEffortValues).toEqual(GENERIC_REASONING_EFFORT_VALUES);
  });
});

describe('parseLlamaServerPropsReasoning', () => {
  it('parses chat_template from /props JSON', () => {
    const r = parseLlamaServerPropsReasoning({ chat_template: QWEN3_ENABLE_THINKING });
    expect(r.missingTemplate).toBe(false);
    expect(r.templateBytes).toBeGreaterThan(0);
    expect(r.caps.enableThinking).toBe(true);
    expect(r.caps.reasoningEffortValues).toBeNull();
  });

  it('merges chat_template_caps.supports_reasoning_effort when the regex missed effort', () => {
    const r = parseLlamaServerPropsReasoning({
      chat_template: PLAIN_CHATML,
      chat_template_caps: { supports_reasoning_effort: true },
    });
    expect(r.caps.enableThinking).toBe(false);
    expect(r.caps.reasoningEffortValues).toEqual(GENERIC_REASONING_EFFORT_VALUES);
  });

  it('flags a missing chat_template', () => {
    const r = parseLlamaServerPropsReasoning({ total_slots: 1 });
    expect(r.missingTemplate).toBe(true);
    expect(r.templateBytes).toBe(0);
    expect(r.caps).toEqual({ enableThinking: false, reasoningEffortValues: null });
  });
});

describe('parseLlamaServerPropsNctx', () => {
  it('reads n_ctx from default_generation_settings', () => {
    expect(
      parseLlamaServerPropsNctx({
        default_generation_settings: { n_ctx: 32768, params: { temperature: 0.8 } },
      }),
    ).toBe(32768);
  });

  it('reads n_ctx from nested params when the top field is missing', () => {
    expect(
      parseLlamaServerPropsNctx({
        default_generation_settings: { params: { n_ctx: 40960 } },
      }),
    ).toBe(40960);
  });

  it('returns null when n_ctx is absent or invalid', () => {
    expect(parseLlamaServerPropsNctx({ chat_template: 'x' })).toBeNull();
    expect(parseLlamaServerPropsNctx({ default_generation_settings: { n_ctx: 0 } })).toBeNull();
    expect(parseLlamaServerPropsNctx(null)).toBeNull();
  });
});

describe('formatChatTemplateReasoningSummary', () => {
  it('formats a compact log line', () => {
    expect(
      formatChatTemplateReasoningSummary({
        enableThinking: true,
        reasoningEffortValues: ['xhigh', 'medium', 'low'],
      }),
    ).toBe('enableThinking=true reasoningEffort=xhigh,medium,low');
  });
});

describe('llm thinking/effort visibility from caps', () => {
  it('uses the Gemma preset when caps are absent', () => {
    expect(llmThinkingControlVisible('gemma', undefined)).toBe(true);
    expect(llmEffortControlVisible('gemma', undefined)).toBe(false);
    expect(llmThinkingControlVisible('generic', undefined)).toBe(false);
    expect(llmEffortControlVisible('generic', undefined)).toBe(true);
  });

  it('shows thinking and effort for the Qwen preset when caps are absent', () => {
    expect(llmThinkingControlVisible('qwen', undefined)).toBe(true);
    expect(llmEffortControlVisible('qwen', undefined)).toBe(true);
  });

  it('hides both when a live scan found neither knob', () => {
    const caps = { enableThinking: false, reasoningEffortValues: null };
    expect(llmThinkingControlVisible('qwen', caps)).toBe(false);
    expect(llmEffortControlVisible('generic', caps)).toBe(false);
    expect(llmThinkingControlVisible('gemma', caps)).toBe(false);
  });

  it('shows thinking from live enableThinking even on a Qwen preset', () => {
    const caps = { enableThinking: true, reasoningEffortValues: null };
    expect(llmThinkingControlVisible('qwen', caps)).toBe(true);
    expect(llmEffortControlVisible('qwen', caps)).toBe(false);
  });

  it('keeps the Qwen thinking toggle when a live scan found an effort list', () => {
    const caps = { enableThinking: false, reasoningEffortValues: ['xhigh', 'medium', 'low'] };
    expect(llmThinkingControlVisible('qwen', caps)).toBe(true);
    expect(llmEffortControlVisible('qwen', caps)).toBe(true);
    expect(llmThinkingControlVisible('generic', caps)).toBe(false);
  });

  it('builds Default plus scanned effort values', () => {
    const opts = llmEffortSelectOptionsFromCaps({
      enableThinking: false,
      reasoningEffortValues: ['xhigh', 'medium', 'low'],
    });
    expect(opts.map((o) => o.value)).toEqual(['', 'xhigh', 'medium', 'low']);
    expect(opts[0]).toEqual({ value: '', label: 'Default' });
  });

  it('falls back to the generic effort list when caps are absent', () => {
    expect(llmEffortSelectOptionsFromCaps(undefined)).toBe(LLM_REASONING_EFFORT_OPTIONS);
    expect(LLM_THINKING_MODE_OPTIONS.map((o) => o.value)).toEqual(['default', 'on', 'off']);
  });

  it('offers the composer only the scanned efforts, without Default or on/off', () => {
    const caps = { enableThinking: true, reasoningEffortValues: ['xhigh', 'medium', 'low'] };
    expect(llmComposerEffortOptions(caps).map((o) => o.value)).toEqual(['xhigh', 'medium', 'low']);
    expect(llmComposerEffortOptions(undefined)).toEqual([]);
    expect(llmComposerEffortOptions({ enableThinking: true, reasoningEffortValues: null })).toEqual([]);
  });

  it('keeps a saved composer effort only when it is offered', () => {
    const opts = llmComposerEffortOptions({ enableThinking: false, reasoningEffortValues: ['low', 'medium', 'xhigh'] });
    expect(llmComposerEffortValue(opts, 'xhigh')).toBe('xhigh');
    expect(llmComposerEffortValue(opts, '')).toBe('medium');
    expect(llmComposerEffortValue(opts, 'on')).toBe('medium');
    expect(llmComposerEffortValue(llmComposerEffortOptions({ enableThinking: false, reasoningEffortValues: ['high'] }), '')).toBe('high');
    expect(llmComposerEffortValue([], 'low')).toBe('');
  });

  it('falls back to low/medium/xhigh for the Qwen preset when caps are absent', () => {
    expect(llmEffortSelectOptionsFromCaps(undefined, 'qwen').map((o) => o.value)).toEqual([
      '',
      'low',
      'medium',
      'xhigh',
    ]);
  });
});
