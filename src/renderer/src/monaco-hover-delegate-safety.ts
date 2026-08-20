/**
 * Clara-owned guard for Monaco IconLabel / suggest-widget hovers — no node_modules edits.
 *
 * StandaloneCodeEditor overwrites a *global* hover-delegate factory with whatever
 * InstantiationService constructed that editor. Diff editors pass a *child* service
 * that is disposed with the diff. After that, suggest-widget IconLabel construction
 * throws ``InstantiationService has been disposed`` and IntelliSense never paints
 * (Lazy caches the first throw forever).
 *
 * Pin the factory to the never-disposed StandaloneServices singleton after every
 * editor create/dispose, and retry Lazy evaluation if that error was already cached.
 * Idempotent install; every call re-pins.
 */

const PATCH_KEY = '__claraHoverDelegateSafetyPatched';

let installPromise: Promise<(() => void) | null> | null = null;

function isDisposedInstantiationError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('InstantiationService has been disposed');
}

async function installHoverDelegateSafety(): Promise<(() => void) | null> {
  const [{ setHoverDelegateFactory }, { Lazy }, { StandaloneServices }, { IInstantiationService }, { WorkbenchHoverDelegate }] =
    await Promise.all([
      import('monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js'),
      import('monaco-editor/esm/vs/base/common/lazy.js'),
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'),
      import('monaco-editor/esm/vs/platform/hover/browser/hover.js'),
    ]);

  type InstantiationServiceLike = {
    createInstance: (ctor: unknown, ...args: unknown[]) => unknown;
  };

  const pin = (): void => {
    setHoverDelegateFactory((placement: string, enableInstantHover: boolean) => {
      const instantiationService = StandaloneServices.get(
        IInstantiationService,
      ) as InstantiationServiceLike;
      return instantiationService.createInstance(
        WorkbenchHoverDelegate,
        placement,
        enableInstantHover,
        {},
      );
    });
  };

  const lazyProto = Lazy.prototype as unknown as Record<string, unknown>;
  if (!lazyProto[PATCH_KEY]) {
    const existing = Object.getOwnPropertyDescriptor(Lazy.prototype, 'value');
    if (existing?.get) {
      Object.defineProperty(Lazy.prototype, 'value', {
        configurable: true,
        enumerable: false,
        get: function (this: { _didRun?: boolean; _error?: unknown; _value?: unknown }) {
          if (isDisposedInstantiationError(this._error)) {
            this._didRun = false;
            this._error = undefined;
            this._value = undefined;
          }
          return existing.get!.call(this);
        },
      });
    }
    lazyProto[PATCH_KEY] = true;
  }

  return pin;
}

export function ensureMonacoHoverDelegateSafe(): Promise<void> {
  installPromise ??= installHoverDelegateSafety().catch((err) => {
    console.warn('[monaco-hover-delegate-safety] failed to pin hover factory', err);
    return null;
  });
  return installPromise.then((pin) => {
    pin?.();
  });
}
