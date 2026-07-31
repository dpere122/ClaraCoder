/**
 * Configure Monaco web workers before any `monaco-editor` import.
 * Paths are relative to this file so the Angular/esbuild pipeline can bundle workers.
 */
const w = window as unknown as {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
};

w.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), {
          type: 'module',
        });
      case 'css':
      case 'scss':
      case 'less':
        return new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), {
          type: 'module',
        });
      case 'html':
      case 'handlebars':
      case 'razor':
        return new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), {
          type: 'module',
        });
      case 'typescript':
      case 'javascript':
        return new Worker(
          new URL('../../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
          { type: 'module' },
        );
      default:
        return new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
          type: 'module',
        });
    }
  },
};
