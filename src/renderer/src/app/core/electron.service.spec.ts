import type { NgZone } from '@angular/core';
import { ElectronService } from './electron.service';

type Listener = (...args: unknown[]) => void;

/** Fake preload API: records every `on*` listener so the test can play IPC messages in order. */
function fakeElectronApi(): { api: unknown; emit: (name: string, ...args: unknown[]) => void } {
  const listeners = new Map<string, Listener>();
  const api = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name.startsWith('on') ? (cb: Listener) => listeners.set(name, cb) : () => undefined,
    },
  );
  return { api, emit: (name, ...args) => listeners.get(name)?.({}, ...args) };
}

describe('ElectronService stream batching', () => {
  const zone = { run: (fn: () => unknown) => fn() } as unknown as NgZone;
  let emit: (name: string, ...args: unknown[]) => void;
  let service: ElectronService;
  let order: string[];
  let pendingFrame: FrameRequestCallback | null;

  beforeEach(() => {
    const fake = fakeElectronApi();
    emit = fake.emit;
    (window as unknown as { electronAPI: unknown }).electronAPI = fake.api;
    pendingFrame = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      pendingFrame = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      pendingFrame = null;
    });
    service = new ElectronService(zone);
    order = [];
    service.chunk$.subscribe((m) => order.push(`chunk:${m.delta}`));
    service.llmStatus$.subscribe((m) => order.push(`status:${m.status.id}`));
    service.acceptCommand$.subscribe(() => order.push('accept'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('delivers text queued for the next frame before a tool status that followed it', () => {
    emit('onMessageChunk', 'c1', 'D', 'agent');
    pendingFrame?.(0);
    // One burst within a frame: the rest of the sentence, then the tool call's preview row.
    emit('onMessageChunk', 'c1', 'ependency build finished clean', 'agent');
    emit('onMessageChunk', 'c1', '.', 'agent');
    emit('onMessageStatus', 'c1', { id: 'native-tool-preview-1', label: 'write_workspace_file', source: 'tool' });

    expect(order).toEqual(['chunk:D', 'chunk:ependency build finished clean.', 'status:native-tool-preview-1']);
    expect(pendingFrame).toBeNull();
  });

  it('delivers queued text before a HITL prompt', () => {
    emit('onMessageChunk', 'c1', 'I’ll run the build', 'agent');
    emit('onMessageAcceptCommand', 'c1', { command: 'npm run build' });

    expect(order).toEqual(['chunk:I’ll run the build', 'accept']);
  });
});
