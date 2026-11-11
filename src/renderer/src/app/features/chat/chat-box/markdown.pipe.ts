import { DOCUMENT } from '@angular/common';
import { Pipe, PipeTransform, SecurityContext, inject } from '@angular/core';
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

/** Only broker-generated capture PNGs may load in assistant markdown (no paths or query strings). */
const CAPTURE_IMAGE_URL = /^nemo-asset:\/\/capture\/[a-f0-9]{32}\.png$/;

function filterMarkdownImages(html: string, document: Document): string {
  // A template is inert: parsing must not fetch an unapproved image before we can reject it.
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll('[srcset], [poster]')) {
    element.removeAttribute('srcset');
    element.removeAttribute('poster');
  }
  for (const image of template.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    // Comparing the whole match also rejects the trailing newline JavaScript's `$` accepts.
    if (CAPTURE_IMAGE_URL.exec(src)?.[0] !== src) {
      image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
      continue;
    }
    // Preserve only inert metadata. DOM serialization escapes alt/title, including raw HTML input.
    for (const attribute of Array.from(image.attributes)) {
      if (!['src', 'alt', 'title'].includes(attribute.name)) {
        image.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly document = inject(DOCUMENT);

  constructor(private sanitizer: DomSanitizer) {}

  /**
   * @param layoutPass Optional monotonic counter (e.g. after `afterNextRender` when a reply finishes);
   *                    bumps invalidate the pure pipe cache so markdown re-parses once the DOM has settled.
   */
  transform(value: string, layoutPass?: number): string {
    void layoutPass;
    const normalized = normalizeLooseAtxHeadings(value ?? '');
    const html = markedInstance.parse(normalized, { async: false }) as string;
    // Filter before sanitization too: never hand ordinary remote images to its HTML parser.
    const filtered = filterMarkdownImages(html, this.document);
    const sanitized = this.sanitizer.sanitize(SecurityContext.HTML, filtered) ?? '';
    // Check again after stripped wrappers/namespace changes. This stays an ordinary string,
    // so Angular's [innerHTML] sanitizer remains enabled as well.
    return filterMarkdownImages(sanitized, this.document);
  }
}
