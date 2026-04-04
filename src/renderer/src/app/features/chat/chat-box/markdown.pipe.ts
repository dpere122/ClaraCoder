import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked } from 'marked';
import hljs from 'highlight.js';

const RUNNABLE_LANGS = ['batch', 'bash', 'powershell', 'ps1', 'bat', 'cmd', 'sh', 'shell'];

const customRenderer = {
  code({ text, lang }: { text: string; lang?: string }): string {
    const language = lang || '';
    const langLower = language.toLowerCase();
    const isRunnable = RUNNABLE_LANGS.some(l => langLower.includes(l));

    console.log('[MarkdownPipe] Code block - language:', language, 'isRunnable:', isRunnable);

    let highlighted: string;
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }

    if (isRunnable) {
      const encodedScript = encodeURIComponent(text);
      const encodedLang = encodeURIComponent(language);
      console.log('[MarkdownPipe] Adding run button for language:', language);
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

  transform(value: string): SafeHtml {
    const html = markedInstance.parse(value, { async: false }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
