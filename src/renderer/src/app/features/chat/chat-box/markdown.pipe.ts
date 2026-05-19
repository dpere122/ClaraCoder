import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { normalizeLooseAtxHeadings } from './markdown-normalize';

const RUNNABLE_LANGS = ['batch', 'bash', 'powershell', 'ps1', 'bat', 'cmd', 'sh', 'shell'];

const customRenderer = {
  code({ text, lang }: { text: string; lang?: string }): string {
    const language = lang || '';
    const langLower = language.toLowerCase();
    const isRunnable = RUNNABLE_LANGS.some(l => langLower.includes(l));

    let highlighted: string;
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }

    if (isRunnable) {
      const encodedScript = encodeURIComponent(text);
      const encodedLang = encodeURIComponent(language);
      return `<div class="code-block-wrapper" data-script="${encodedScript}" data-language="${encodedLang}">
        <button class="code-block-run-btn">Run</button>
        <pre><code class="hljs language-${language}">${highlighted}</code></pre>
      </div>`;
    }

    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
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
  transform(value: string, layoutPass?: number): SafeHtml {
    void layoutPass;
    const normalized = normalizeLooseAtxHeadings(value ?? '');
    const html = markedInstance.parse(normalized, { async: false }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
