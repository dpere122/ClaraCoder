import { Marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

/** Context needed to resolve workspace-relative image paths in a markdown document. */
export interface MarkdownDocRenderContext {
  /** Absolute workspace root path. */
  workspaceRoot: string;
  /** POSIX relative path of the markdown file within the workspace. */
  fileRelativePath: string;
}

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

function isExternalOrDataUrl(href: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(href.trim());
}

/** Normalizes `../`/`./` segments in a POSIX path; returns null when the path escapes the root. */
function normalizePosixWithinRoot(parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Maps an image `src` from the markdown source to a loadable URL.
 * Relative paths resolve against the markdown file's directory and are served through the
 * `nemo-asset://` protocol (validated against the workspace root in the main process).
 */
export function resolveDocImageSrc(href: string, ctx: MarkdownDocRenderContext): string | null {
  const raw = href.trim();
  if (!raw) {
    return null;
  }
  if (isExternalOrDataUrl(raw)) {
    return raw;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // Any other scheme (file:, javascript:, ...) is not allowed.
    return null;
  }
  const fileDirParts = ctx.fileRelativePath.split('/').slice(0, -1);
  const hrefParts = raw.replace(/\\/g, '/').split('/');
  // Leading slash means workspace-root-relative; otherwise relative to the md file's directory.
  const combined = raw.startsWith('/') ? hrefParts : [...fileDirParts, ...hrefParts];
  const rel = normalizePosixWithinRoot(combined);
  if (!rel) {
    return null;
  }
  return `nemo-asset://workspace/?root=${encodeURIComponent(ctx.workspaceRoot)}&path=${encodeURIComponent(rel)}`;
}

function createMarked(ctx: MarkdownDocRenderContext): Marked {
  const m = new Marked();
  m.use({
    renderer: {
      code({ text, lang }: { text: string; lang?: string }): string {
        const language = lang || '';
        let highlighted: string;
        if (language && hljs.getLanguage(language)) {
          highlighted = hljs.highlight(text, { language }).value;
        } else {
          highlighted = hljs.highlightAuto(text).value;
        }
        return `<pre><code class="hljs language-${safeLanguageClass(language)}">${highlighted}</code></pre>`;
      },
      image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
        const resolved = resolveDocImageSrc(href ?? '', ctx);
        if (!resolved) {
          return `<span class="md-doc-broken-image">${escapeHtmlAttr(text || href || 'image')}</span>`;
        }
        const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : '';
        return `<img src="${escapeHtmlAttr(resolved)}" alt="${escapeHtmlAttr(text ?? '')}"${titleAttr}>`;
      },
    },
  });
  return m;
}

let purifyHooked = false;

function ensurePurifyHooks(): void {
  if (purifyHooked) {
    return;
  }
  purifyHooked = true;
  // External links must not navigate the Electron window away from the app.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Default DOMPurify URI allowlist plus the `nemo-asset:` workspace image scheme. */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|nemo-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/**
 * Renders a markdown document to sanitized HTML for the editor preview pane.
 * Output is safe to bind via `bypassSecurityTrustHtml` (DOMPurify allowlist; no scripts/handlers).
 */
export function renderMarkdownDoc(markdown: string, ctx: MarkdownDocRenderContext): string {
  ensurePurifyHooks();
  const html = createMarked(ctx).parse(markdown ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  });
}
