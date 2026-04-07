import { Pipe, PipeTransform } from '@angular/core';

export type HealthLogMessageFormat = 'raw' | 'json' | 'xml';

function parseJsonFlexible(text: string): unknown | undefined {
  const t = text.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    /* fall through */
  }
  const openIdx = t.indexOf('{');
  if (openIdx >= 0) {
    let depth = 0;
    for (let i = openIdx; i < t.length; i++) {
      const c = t[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(openIdx, i + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
  }
  const brOpen = t.indexOf('[');
  if (brOpen >= 0) {
    let depth = 0;
    for (let i = brOpen; i < t.length; i++) {
      const c = t[i];
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(brOpen, i + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function prettyXmlElement(el: Element, indent: number): string {
  const pad = '  '.repeat(indent);
  const tag = el.tagName;
  let open = `${pad}<${tag}`;
  for (const a of Array.from(el.attributes)) {
    open += ` ${a.name}="${escapeXmlText(a.value)}"`;
  }
  const childEls = Array.from(el.childNodes).filter((n) => n.nodeType === Node.ELEMENT_NODE) as Element[];
  const textNodes = Array.from(el.childNodes).filter(
    (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim(),
  );
  if (childEls.length === 0 && textNodes.length === 0) {
    return `${open}/>\n`;
  }
  if (childEls.length === 0 && textNodes.length === 1) {
    const tx = escapeXmlText((textNodes[0].textContent || '').trim());
    return `${open}>${tx}</${tag}>\n`;
  }
  let body = `${open}>\n`;
  for (const c of childEls) {
    body += prettyXmlElement(c, indent + 1);
  }
  for (const tn of textNodes) {
    body += `${pad}  ${escapeXmlText((tn.textContent || '').trim())}\n`;
  }
  body += `${pad}</${tag}>\n`;
  return body;
}

function tryPrettyXml(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('<')) return undefined;
  const doc = new DOMParser().parseFromString(t, 'application/xml');
  const pe = doc.getElementsByTagName('parsererror');
  if (pe.length > 0) return undefined;
  const root = doc.documentElement;
  if (!root) return undefined;
  return prettyXmlElement(root, 0).trimEnd();
}

export function formatHealthLogMessage(message: string, format: HealthLogMessageFormat): string {
  if (format === 'raw' || !message) {
    return message;
  }
  if (format === 'json') {
    const v = parseJsonFlexible(message);
    if (v !== undefined) {
      return JSON.stringify(v, null, 2);
    }
    return message;
  }
  if (format === 'xml') {
    const x = tryPrettyXml(message);
    if (x !== undefined) {
      return x;
    }
    return message;
  }
  return message;
}

@Pipe({ name: 'healthLogMessage', standalone: true, pure: true })
export class HealthLogMessagePipe implements PipeTransform {
  transform(message: string, format: HealthLogMessageFormat): string {
    return formatHealthLogMessage(message, format);
  }
}
