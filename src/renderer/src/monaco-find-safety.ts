/**
 * Clara-owned guard for Monaco FindWidget — no node_modules edits.
 *
 * Upstream FindWidget registers onFindReplaceStateChange before _buildDomNode()
 * creates `_toggleSelectionFind`. A concurrent editor.setModel() then does
 * state.change({ searchScope: null }) and crashes:
 *   TypeError: Cannot set properties of undefined (setting 'checked')
 *
 * We wrap the private handlers so mid-construction state events are ignored.
 * Idempotent.
 */

type FindWidgetCtor = {
  prototype: {
    _onStateChanged?: (e: unknown) => void;
    _reveal?: (...args: unknown[]) => void;
  };
};

const PATCH_KEY = '__claraFindWidgetSafetyPatched';

let patchPromise: Promise<void> | null = null;

function widgetReady(widget: { _findInput?: unknown; _toggleSelectionFind?: unknown }): boolean {
  return Boolean(widget._findInput && widget._toggleSelectionFind);
}

export function ensureMonacoFindWidgetSafe(): Promise<void> {
  patchPromise ??= (async () => {
    const mod = await import('monaco-editor/esm/vs/editor/contrib/find/browser/findWidget.js');
    const FindWidget = (mod as { FindWidget?: FindWidgetCtor }).FindWidget;
    if (!FindWidget?.prototype) {
      console.warn('[monaco-find-safety] FindWidget export missing; skip');
      return;
    }
    const proto = FindWidget.prototype as FindWidgetCtor['prototype'] & Record<string, unknown>;
    if (proto[PATCH_KEY]) {
      return;
    }

    const originalOnStateChanged = proto._onStateChanged;
    if (typeof originalOnStateChanged === 'function') {
      proto._onStateChanged = function (this: { _findInput?: unknown; _toggleSelectionFind?: unknown }, e: unknown) {
        if (!widgetReady(this)) {
          return;
        }
        return originalOnStateChanged.call(this, e);
      };
    }

    const originalReveal = proto._reveal;
    if (typeof originalReveal === 'function') {
      proto._reveal = function (this: { _findInput?: unknown; _toggleSelectionFind?: unknown }, ...args: unknown[]) {
        if (!widgetReady(this)) {
          return;
        }
        return originalReveal.apply(this, args);
      };
    }

    proto[PATCH_KEY] = true;
  })().catch((err) => {
    console.warn('[monaco-find-safety] failed to apply FindWidget guard', err);
  });
  return patchPromise;
}
