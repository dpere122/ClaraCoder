import { Pipe, PipeTransform, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { normalizeLooseAtxHeadings } from './markdown-normalize';

const RUNNABLE_LANGS = ['batch', 'bash', 'powershell', 'ps1', 'bat', 'cmd', 'sh', 'shell'];

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeLanguageClass(lang: string): string {
  const cleaned = lang.toLowerCase().replace(/[^a-z0-9+#.-]/g, '');
  return cleaned || 'plaintext';
}

const customRenderer = {
  code({ text, lang }: { text: string; lang?: string }): string {
    const language = lang || '';
    const langLower = language.toLowerCase();
    const isRunnable = RUNNABLE_LANGS.some((l) => langLower.includes(l));

    let highlighted: string;
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }

    const langClass = safeLanguageClass(language);

    if (isRunnable) {
      const encodedScript = encodeURIComponent(text);
      const encodedLang = encodeURIComponent(language);
      return `<div class="code-block-wrapper" data-script="${escapeHtmlAttr(encodedScript)}" data-language="${escapeHtmlAttr(encodedLang)}">
        <button class="code-block-run-btn" type="button">Run</button>
        <pre><code class="hljs language-${langClass}">${highlighted}</code></pre>
      </div>`;
    }

    return `<pre><code class="hljs language-${langClass}">${highlighted}</code></pre>`;
  },
};

const markedInstance = new Marked();
markedInstance.use({ renderer: customRenderer });

@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  /**
   * @param layoutPass Optional monotonic counter (e.g. after `afterNextRender` when a reply finishes);
   *                    bumps invalidate the pure pipe cache so markdown re-parses once the DOM has settled.
   */
  transform(value: string, layoutPass?: number): string {
    void layoutPass;
    const normalized = normalizeLooseAtxHeadings(value ?? '');
    const html = markedInstance.parse(normalized, { async: false }) as string;
    return this.sanitizer.sanitize(SecurityContext.HTML, html) ?? '';
  }
}
