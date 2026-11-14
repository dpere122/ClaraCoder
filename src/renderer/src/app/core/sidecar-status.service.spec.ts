import { TestBed } from '@angular/core/testing';
import type { SidecarStartupState } from '@shared/index';
import { describe, expect, it, vi } from 'vitest';
import { ElectronService } from './electron.service';
import { SidecarStatusService } from './sidecar-status.service';

/** Lets the startup question (or its failure) settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

function setup(answer: () => Promise<SidecarStartupState>, isElectron = true) {
  let push: ((state: SidecarStartupState) => void) | null = null;
  const electron = {
    isElectron,
    sidecarStartupState: vi.fn(answer),
    onSidecarStartupState: vi.fn((cb: (state: SidecarStartupState) => void) => {
      push = cb;
      return () => undefined;
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ElectronService, useValue: electron }] });
  const service = TestBed.inject(SidecarStatusService);
  return { service, electron, push: (state: SidecarStartupState) => push?.(state) };
}

describe('SidecarStatusService', () => {
  it('is loading until the main process says the sidecar is ready', async () => {
    const { service, push } = setup(async () => 'starting');
    expect(service.loading()).toBe(true);
    await settle();
    expect(service.loading()).toBe(true);

    push('ready');
    expect(service.loading()).toBe(false);
  });

  it('takes the answer when the sidecar was already up', async () => {
    const { service } = setup(async () => 'ready');
    await settle();
    expect(service.state()).toBe('ready');
  });

  it('stops loading when the sidecar failed to start', async () => {
    const { service } = setup(async () => 'failed');
    await settle();
    expect(service.state()).toBe('failed');
    expect(service.loading()).toBe(false);
  });

  it('goes back to loading when the sidecar restarts', async () => {
    const { service, push } = setup(async () => 'ready');
    await settle();

    push('starting');
    expect(service.loading()).toBe(true);
    push('ready');
    expect(service.loading()).toBe(false);
  });

  it('keeps a push that lands before the answer', async () => {
    let resolve: (state: SidecarStartupState) => void = () => undefined;
    const { service, push } = setup(() => new Promise<SidecarStartupState>((r) => (resolve = r)));

    push('ready');
    resolve('starting');
    await settle();
    expect(service.state()).toBe('ready');
  });

  it('does not hold the UI back when the question fails', async () => {
    const { service } = setup(async () => {
      throw new Error('no handler');
    });
    await settle();
    expect(service.loading()).toBe(false);
  });

  it('is ready outside the app', () => {
    const { service, electron } = setup(async () => 'starting', false);
    expect(service.loading()).toBe(false);
    expect(electron.sidecarStartupState).not.toHaveBeenCalled();
  });
});
