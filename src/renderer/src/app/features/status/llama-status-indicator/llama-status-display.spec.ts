import { computeStatusPollIntervalMs, healthDotState } from './llama-status-display';

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

  it('maps stopped, error and off to red', () => {
    expect(healthDotState('stopped')).toBe('red');
    expect(healthDotState('error')).toBe('red');
    expect(healthDotState('off')).toBe('red');
  });
});
