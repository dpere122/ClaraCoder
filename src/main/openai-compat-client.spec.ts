import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAiCompatListModels, openAiCompatUrl, runOpenAiCompatTest } from './openai-compat-client';

type Body = Record<string, unknown>;
type Reply = { status?: number; json?: unknown; sse?: unknown[] };

const ok = (message: Body = { role: 'assistant', content: 'ok' }, usage?: Body): Reply => ({
  json: { choices: [{ message }], ...(usage ? { usage } : {}) },
});
const stream = (usage = true): Reply => ({
  sse: [{ choices: [{ delta: { content: 'ok' } }] }, ...(usage ? [{ choices: [], usage: { total_tokens: 3 } }] : [])],
});
const toolCall = ok({ role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'ping', arguments: '{}' } }] });

/** Fake server: ``chat`` decides each POST from its body; returns every chat body it was sent. */
function server(chat: (body: Body) => Reply, models: Reply = { json: { data: [{ id: 'm1' }] } }) {
  const bodies: Body[] = [];
  const seenHeaders: Record<string, string>[] = [];
  const toResponse = (r: Reply): Response => {
    if (r.sse) {
      const text = r.sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(text, { status: 200 });
    }
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      if (url.endsWith('/models')) {
        return toResponse(models);
      }
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return toResponse(chat(body));
    }),
  );
  return { bodies, seenHeaders };
}

/** A server that works, routing by what the request is testing. */
const healthy = (over: Partial<Record<'chat' | 'stream' | 'tools', Reply>> = {}) => (body: Body): Reply => {
  if (body['stream']) {
    return over.stream ?? stream();
  }
  return body['tools'] ? (over.tools ?? toolCall) : (over.chat ?? ok());
};

const endpoint = { baseUrl: 'http://x/v1' };
const statusOf = (r: Awaited<ReturnType<typeof runOpenAiCompatTest>>, id: string) => r.checks.find((c) => c.id === id)?.status;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openAiCompatUrl', () => {
  it('uses the path the user gave, adding /v1 only when there is none', () => {
    expect(openAiCompatUrl('http://x/v1/', 'models')).toBe('http://x/v1/models');
    expect(openAiCompatUrl('http://x', 'models')).toBe('http://x/v1/models');
    expect(openAiCompatUrl('https://x/api/openai/v2', 'chat/completions')).toBe('https://x/api/openai/v2/chat/completions');
  });

  it('refuses anything that is not http', () => {
    expect(openAiCompatUrl('file:///etc/passwd', 'models')).toBeNull();
    expect(openAiCompatUrl('', 'models')).toBeNull();
  });
});

describe('openAiCompatUrl on a bind-all address', () => {
  it('uses the address chat requests go to', () => {
    expect(openAiCompatUrl('http://0.0.0.0:8080/v1', 'models')).toBe('http://127.0.0.1:8080/v1/models');
  });
});

describe('request headers', () => {
  it('let a custom Authorization header win over the key, as chat requests do', async () => {
    const { seenHeaders } = server(healthy());
    await openAiCompatListModels({ baseUrl: 'http://x/v1', apiKey: 'key', headers: [{ key: 'authorization', value: 'Token abc' }] });
    expect(seenHeaders[0]?.['authorization']).toBe('Token abc');
    expect(seenHeaders[0]?.['Authorization']).toBeUndefined();
  });
});

describe('openAiCompatListModels', () => {
  it('reads ids and any context length the server reports, under its various names', async () => {
    server(healthy(), { json: { data: [{ id: 'a', context_length: 1000 }, { id: 'b', max_model_len: 2000 }, { id: 'c', meta: { n_ctx_train: 3000 } }, { id: 'd' }] } });
    expect(await openAiCompatListModels(endpoint)).toEqual({
      ok: true,
      models: [{ id: 'a', contextLength: 1000 }, { id: 'b', contextLength: 2000 }, { id: 'c', contextLength: 3000 }, { id: 'd' }],
    });
  });

  it('sends the API key and custom headers', async () => {
    const { seenHeaders } = server(healthy());
    await openAiCompatListModels({ ...endpoint, apiKey: 'k', headers: [{ key: 'api-key', value: 'azure' }, { key: ' ', value: 'dropped' }] });
    expect(seenHeaders[0]).toMatchObject({ Authorization: 'Bearer k', 'api-key': 'azure' });
    expect(Object.keys(seenHeaders[0]!)).not.toContain(' ');
  });

  it("reports the server's error message", async () => {
    server(healthy(), { status: 500, json: { error: { message: 'boom' } } });
    expect(await openAiCompatListModels(endpoint)).toEqual({ ok: false, error: 'HTTP 500: boom' });
  });
});

describe('runOpenAiCompatTest', () => {
  it('passes every check on a server that handles everything', async () => {
    server(healthy());
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'skipped']);
    expect(r.suggestions).toEqual({ tokensField: 'max_tokens', sendTemperature: true, streamUsage: true, sendParallelToolCalls: true, thinkingMethod: 'none' });
  });

  it('stops at a rejected key instead of sending more requests', async () => {
    const { bodies } = server(healthy(), { status: 401 });
    const r = await runOpenAiCompatTest({ ...endpoint, apiKey: 'bad' }, 'm1');
    expect(statusOf(r, 'reachable')).toBe('fail');
    expect(r.checks.find((c) => c.id === 'reachable')?.detail).toContain('API key');
    expect(statusOf(r, 'chat')).toBe('skipped');
    expect(bodies).toEqual([]);
  });

  it('stops when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }))));
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(statusOf(r, 'reachable')).toBe('fail');
    expect(r.checks.find((c) => c.id === 'reachable')?.detail).toContain('ECONNREFUSED');
  });

  it('carries on without a model list, since many servers have none', async () => {
    server(healthy(), { status: 404 });
    const r = await runOpenAiCompatTest(endpoint, 'typed-id');
    expect(statusOf(r, 'models')).toBe('warn');
    expect(statusOf(r, 'chat')).toBe('ok');
    expect(r.testedModel).toBe('typed-id');
  });

  it('tests the first listed model when none is selected, and asks for one when none is listed', async () => {
    server(healthy());
    expect((await runOpenAiCompatTest(endpoint, '')).testedModel).toBe('m1');
    const { bodies } = server(healthy(), { status: 404 });
    const r = await runOpenAiCompatTest(endpoint, '');
    expect(statusOf(r, 'chat')).toBe('skipped');
    expect(bodies).toEqual([]);
  });

  it('learns that a server wants max_completion_tokens from its error', async () => {
    const { bodies } = server((body) =>
      body['max_tokens'] !== undefined
        ? { status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } } }
        : healthy()(body),
    );
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.suggestions.tokensField).toBe('max_completion_tokens');
    expect(statusOf(r, 'chat')).toBe('ok');
    expect(bodies.at(-1)).toHaveProperty('max_completion_tokens');
    expect(bodies.at(-1)).not.toHaveProperty('max_tokens');
  });

  it('learns that a model rejects temperature', async () => {
    server((body) =>
      body['temperature'] !== undefined
        ? { status: 400, json: { error: { message: "'temperature' does not support 0.2 with this model." } } }
        : healthy()(body),
    );
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.suggestions.sendTemperature).toBe(false);
    expect(statusOf(r, 'chat')).toBe('ok');
  });

  it('handles both of those at once', async () => {
    server((body) => {
      if (body['max_tokens'] !== undefined) {
        return { status: 400, json: { error: 'max_tokens is not supported' } };
      }
      return body['temperature'] !== undefined ? { status: 400, json: { error: 'temperature is not supported' } } : healthy()(body);
    });
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.suggestions).toMatchObject({ tokensField: 'max_completion_tokens', sendTemperature: false });
  });

  it('skips the other checks when chat itself fails, without guessing a cause', async () => {
    const { bodies } = server(() => ({ status: 400, json: { error: { message: 'model not found' } } }));
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.checks.find((c) => c.id === 'chat')?.detail).toContain('model not found');
    expect(statusOf(r, 'stream')).toBe('skipped');
    expect(bodies.length).toBe(1);
    expect(r.suggestions).toEqual({});
  });

  it('turns stream usage off when the server rejects stream_options', async () => {
    server((body) => (body['stream_options'] ? { status: 400, json: { error: 'unknown field stream_options' } } : healthy({ stream: stream(false) })(body)));
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.suggestions.streamUsage).toBe(false);
    expect(statusOf(r, 'stream')).toBe('warn');
  });

  it('warns when a server streams but reports no usage', async () => {
    server(healthy({ stream: stream(false) }));
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(statusOf(r, 'stream')).toBe('warn');
    expect(r.suggestions.streamUsage).toBe(true);
  });

  it('fails streaming when no chunks arrive, since Clara always streams', async () => {
    server(healthy({ stream: { sse: [] } }));
    expect(statusOf(await runOpenAiCompatTest(endpoint, 'm1'), 'stream')).toBe('fail');
  });

  it('warns when the model ignores the tool, and fails when the server rejects tools', async () => {
    server(healthy({ tools: ok() }));
    expect(statusOf(await runOpenAiCompatTest(endpoint, 'm1'), 'tools')).toBe('warn');
    server(healthy({ tools: { status: 400, json: { error: 'tools are not supported' } } }));
    expect(statusOf(await runOpenAiCompatTest(endpoint, 'm1'), 'tools')).toBe('fail');
  });

  it('turns off parallel_tool_calls when the server rejects that field', async () => {
    server((body) => (body['parallel_tool_calls'] ? { status: 400, json: { error: 'unknown parallel_tool_calls' } } : healthy()(body)));
    const r = await runOpenAiCompatTest(endpoint, 'm1');
    expect(r.suggestions.sendParallelToolCalls).toBe(false);
    expect(statusOf(r, 'tools')).toBe('ok');
  });

  describe('thinking', () => {
    const thinks = ok({ role: 'assistant', content: 'ok', reasoning_content: 'hmm' });

    it('finds the setting that turns it off', async () => {
      server((body) => {
        if (body['stream']) {
          return stream();
        }
        if (body['tools']) {
          return toolCall;
        }
        return (body['reasoning_effort'] === 'none' ? ok() : thinks);
      });
      const r = await runOpenAiCompatTest(endpoint, 'm1');
      expect(r.suggestions.thinkingMethod).toBe('reasoning_effort');
      expect(statusOf(r, 'thinking')).toBe('ok');
    });

    it('tries the others in turn, including a server that rejects the first', async () => {
      server((body) => {
        if (body['stream']) {
          return stream();
        }
        if (body['tools']) {
          return toolCall;
        }
        if (body['reasoning_effort']) {
          return { status: 400, json: { error: 'unknown field' } };
        }
        return asThinkingOff(body) ? ok() : thinks;
      });
      expect((await runOpenAiCompatTest(endpoint, 'm1')).suggestions.thinkingMethod).toBe('chat_template_kwargs');
    });

    it('notices thinking returned inside the reply, and keeps a control that turns it off', async () => {
      server((body) => {
        if (body['stream']) {
          return stream();
        }
        if (body['tools']) {
          return toolCall;
        }
        return ok({ role: 'assistant', content: body['reasoning_effort'] === 'none' ? '<think>\n\n</think>\n\nok' : '<think>Plan it.</think>ok' });
      });
      const r = await runOpenAiCompatTest(endpoint, 'm1');
      expect(r.suggestions.thinkingMethod).toBe('reasoning_effort');
      expect(statusOf(r, 'thinking')).toBe('ok');
    });

    it('notices thinking from the usage count when the text is hidden', async () => {
      server((body) => {
        if (body['stream']) {
          return stream();
        }
        if (body['tools']) {
          return toolCall;
        }
        return ok({ role: 'assistant', content: 'ok' }, { completion_tokens_details: { reasoning_tokens: body['reasoning'] ? 0 : 20 } });
      });
      expect((await runOpenAiCompatTest(endpoint, 'm1')).suggestions.thinkingMethod).toBe('reasoning');
    });

    it('says so when nothing turns it off', async () => {
      server(healthy({ chat: thinks }));
      const r = await runOpenAiCompatTest(endpoint, 'm1');
      expect(statusOf(r, 'thinking')).toBe('warn');
      expect(r.suggestions.thinkingMethod).toBe('none');
    });

    const asThinkingOff = (body: Body) =>
      (body['chat_template_kwargs'] as { enable_thinking?: boolean } | undefined)?.enable_thinking === false;
  });
});
