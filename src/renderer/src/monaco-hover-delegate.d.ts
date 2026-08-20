declare module 'monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js' {
  export function setHoverDelegateFactory(
    hoverDelegateProvider: (placement: string, enableInstantHover: boolean) => unknown,
  ): void;
  export function getDefaultHoverDelegate(placement: string): unknown;
}

declare module 'monaco-editor/esm/vs/base/common/lazy.js' {
  export class Lazy<T> {
    constructor(executor: () => T);
    get value(): T;
  }
}

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export namespace StandaloneServices {
    function get<T>(serviceId: unknown): T;
  }
}

declare module 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js' {
  export const IInstantiationService: unknown;
}

declare module 'monaco-editor/esm/vs/platform/hover/browser/hover.js' {
  export class WorkbenchHoverDelegate {
    constructor(
      placement: string,
      instantHover: boolean,
      overrideOptions: Record<string, unknown>,
      ...rest: unknown[]
    );
  }
}
