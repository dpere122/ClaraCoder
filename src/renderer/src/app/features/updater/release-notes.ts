import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false });

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Own DOMPurify instance so the link hook doesn't leak into other sanitizers on the page. */
function releaseNotesPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  // Links open in the OS browser (the window's open handler); never navigate the Updates window.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return purifier;
}

/** GitHub release message (markdown) → sanitized HTML for the notes pane. */
export function renderReleaseNotes(markdown: string): string {
  const html = marked.parse(markdown ?? '', { async: false }) as string;
  return releaseNotesPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
  });
}
