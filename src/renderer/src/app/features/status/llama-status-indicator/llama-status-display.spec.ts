import { computeStatusPollIntervalMs, embeddingsStatusDotState, healthDotState, modelStatusDotState } from './llama-status-display';

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
