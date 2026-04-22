import {
  computeStatusPollIntervalMs,
  crystalVisualTargets,
  expSmoothingAlpha,
  llamaCrystalAggregateFromPayload,
  lerp,
} from './llama-connection-display';

describe('llamaCrystalAggregateFromPayload', () => {
  it('returns off when null or not running', () => {
    expect(llamaCrystalAggregateFromPayload(null)).toBe('off');
    expect(
      llamaCrystalAggregateFromPayload({
        ok: true,
        running: false,
        modelId: 'm',
        chat: { port: 0, health: 'stopped' },
      }),
    ).toBe('off');
  });

  it('prioritizes error over loading and ok', () => {
    expect(
      llamaCrystalAggregateFromPayload({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
        embed: { port: 2, health: 'error' },
      }),
    ).toBe('error');
    expect(
      llamaCrystalAggregateFromPayload({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'loading' },
        embed: { port: 2, health: 'error' },
      }),
    ).toBe('error');
  });

  it('returns loading when any part is loading and none error', () => {
    expect(
      llamaCrystalAggregateFromPayload({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'loading' },
        embed: { port: 2, health: 'ok' },
      }),
    ).toBe('loading');
  });

  it('returns ok only when all parts ok', () => {
    expect(
      llamaCrystalAggregateFromPayload({
        ok: true,
        running: true,
        modelId: 'm',
        chat: { port: 1, health: 'ok' },
        embed: { port: 2, health: 'ok' },
      }),
    ).toBe('ok');
  });
});

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
});

describe('crystalVisualTargets', () => {
  it('returns distinct emissive settings per aggregate', () => {
    const off = crystalVisualTargets('off');
    const ok = crystalVisualTargets('ok');
    expect(off.emissiveIntensity).not.toBe(ok.emissiveIntensity);
    expect(ok.loadingPulseAmplitude).toBe(0);
    expect(crystalVisualTargets('loading').loadingPulseAmplitude).toBeGreaterThan(0);
  });
});

describe('lerp and expSmoothingAlpha', () => {
  it('lerps midpoint', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('expSmoothingAlpha approaches 1 for large dt', () => {
    expect(expSmoothingAlpha(10, 0.1)).toBeCloseTo(1, 5);
  });
});
