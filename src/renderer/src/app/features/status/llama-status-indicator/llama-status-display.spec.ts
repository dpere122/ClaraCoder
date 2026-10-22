import {
  computeStatusPollIntervalMs,
  embeddingsStatusDotState,
  embeddingsStatusSummary,
  healthDotState,
  modelStatusDotState,
  modelStatusSummary,
  openRouterModelDotState,
} from './llama-status-display';

describe('computeStatusPollIntervalMs', () => {
  it('uses short interval when not ok or not running', () => {
    expect(computeStatusPollIntervalMs(null)).toBe(2500);
    expect(computeStatusPollIntervalMs({ ok: false, error: 'x' })).toBe(2500);
    expect(
      computeStatusPollIntervalMs({
        ok: true,
        running: false,
        modelId: 'm',
        chat: { port: 0, health: 'stopped' },
      }),
    ).toBe(2500);
  });

  it('uses long interval when running and all ok', () => {
    expect(
      computeStatusPollIntervalMs({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
      }),
    ).toBe(15000);
    expect(
      computeStatusPollIntervalMs({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
        embed: { port: 2, health: 'ok' },
      }),
    ).toBe(15000);
  });

  it('uses short interval when embed not ok', () => {
    expect(
      computeStatusPollIntervalMs({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
        embed: { port: 2, health: 'loading' },
      }),
    ).toBe(2500);
  });

  it('uses long interval when remote and all probed parts are ok', () => {
    expect(
      computeStatusPollIntervalMs({
        ok: true,
        remote: true,
        running: false,
        modelId: 'm',
        chat: { port: 8080, health: 'ok' },
        embed: { port: 8081, health: 'ok' },
      }),
    ).toBe(15000);
  });
});

describe('healthDotState', () => {
  it('maps ok to green', () => {
    expect(healthDotState('ok')).toBe('green');
  });

  it('maps loading to yellow', () => {
    expect(healthDotState('loading')).toBe('yellow');
  });

  it('maps stopped and off to gray', () => {
    expect(healthDotState('stopped')).toBe('gray');
    expect(healthDotState('off')).toBe('gray');
  });

  it('maps error to red', () => {
    expect(healthDotState('error')).toBe('red');
  });
});

describe('embeddingsStatusDotState', () => {
  it('maps ready to green', () => {
    expect(embeddingsStatusDotState('ready')).toBe('green');
  });

  it('maps loading to yellow', () => {
    expect(embeddingsStatusDotState('loading')).toBe('yellow');
  });

  it('maps idle and disabled to gray', () => {
    expect(embeddingsStatusDotState('idle')).toBe('gray');
    expect(embeddingsStatusDotState('disabled')).toBe('gray');
  });

  it('maps error to red', () => {
    expect(embeddingsStatusDotState('error')).toBe('red');
  });
});

describe('modelStatusDotState', () => {
  it('is yellow while the managed server is starting', () => {
    expect(modelStatusDotState('starting', null)).toBe('yellow');
    expect(
      modelStatusDotState(null, {
        ok: true,
        running: false,
        starting: true,
        modelId: 'm',
        chat: { port: 1, health: 'loading' },
      }),
    ).toBe('yellow');
  });

  it('is yellow while weights are downloading', () => {
    expect(modelStatusDotState('downloading', null)).toBe('yellow');
  });

  it('is gray when stopped and not starting', () => {
    expect(
      modelStatusDotState(null, {
        ok: true,
        running: false,
        modelId: 'm',
        chat: { port: 0, health: 'stopped' },
      }),
    ).toBe('gray');
  });

  it('uses chat health once the managed server is running', () => {
    expect(
      modelStatusDotState(null, {
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
      }),
    ).toBe('green');
  });
});

describe('openRouterModelDotState', () => {
  it('is green when a model id and API key are set', () => {
    expect(openRouterModelDotState('anthropic/claude-sonnet-4.5', 'sk-or-test')).toBe('green');
  });

  it('is gray until both the model and API key are set', () => {
    expect(openRouterModelDotState('', 'sk-or-test')).toBe('gray');
    expect(openRouterModelDotState('anthropic/claude-sonnet-4.5', '  ')).toBe('gray');
  });
});

describe('modelStatusSummary', () => {
  const running = {
    ok: true as const,
    running: true,
    modelId: 'm',
    chat: { port: 8080, health: 'ok' as const },
  };

  it('says when nothing is selected', () => {
    expect(modelStatusSummary({ provider: null, dot: 'gray', warming: null, status: null, model: '' })).toBe(
      'No model selected',
    );
  });

  it('reports OpenRouter as connected with its model, or what it still needs', () => {
    expect(
      modelStatusSummary({ provider: 'openrouter', dot: 'green', warming: null, status: null, model: 'deepseek/v4' }),
    ).toBe('Connected · deepseek/v4');
    expect(modelStatusSummary({ provider: 'openrouter', dot: 'gray', warming: null, status: null, model: '' })).toBe(
      'Needs a model and API key',
    );
  });

  it('follows the managed llama-server through download, start, run and stop', () => {
    const base = { provider: 'llamacpp', model: 'qwen' };
    expect(modelStatusSummary({ ...base, dot: 'yellow', warming: 'downloading', status: null })).toBe(
      'Downloading weights…',
    );
    expect(modelStatusSummary({ ...base, dot: 'yellow', warming: 'starting', status: null })).toBe('Starting…');
    expect(modelStatusSummary({ ...base, dot: 'green', warming: null, status: running })).toBe('Running');
    expect(
      modelStatusSummary({
        ...base,
        dot: 'yellow',
        warming: null,
        status: { ...running, chat: { port: 8080, health: 'loading' } },
      }),
    ).toBe('Loading model…');
    expect(modelStatusSummary({ ...base, dot: 'gray', warming: null, status: { ...running, running: false } })).toBe(
      'Stopped',
    );
    expect(modelStatusSummary({ ...base, dot: 'gray', warming: null, status: { ok: false, error: 'x' } })).toBe(
      'Stopped',
    );
  });

  it('reports a remote llama URL as connected rather than running', () => {
    const remote = { ...running, running: false, remote: true };
    expect(modelStatusSummary({ provider: 'llamacpp', dot: 'green', warming: null, status: remote, model: '' })).toBe(
      'Connected',
    );
    expect(modelStatusSummary({ provider: 'llamacpp', dot: 'red', warming: null, status: remote, model: '' })).toBe(
      'Not responding',
    );
  });

  it('does not claim a status for sources it never probes', () => {
    expect(modelStatusSummary({ provider: 'lmstudio', dot: 'gray', warming: null, status: null, model: 'x' })).toBe(
      'Not checked for this source',
    );
  });
});

describe('embeddingsStatusSummary', () => {
  it('maps each load status to a short label', () => {
    expect(embeddingsStatusSummary('ready')).toBe('Ready');
    expect(embeddingsStatusSummary('loading')).toBe('Loading…');
    expect(embeddingsStatusSummary('idle')).toBe('Loads on first search');
    expect(embeddingsStatusSummary('disabled')).toBe('Off');
    expect(embeddingsStatusSummary('error')).toBe('Error');
    expect(embeddingsStatusSummary(null)).toBe('Unknown');
  });
});
