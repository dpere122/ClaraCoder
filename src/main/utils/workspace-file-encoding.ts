/**
 * Encode workspace file text for disk writes (must stay aligned with Python `workspace_text_io`).
 */
import iconv from 'iconv-lite';

const ALLOWED = new Set([
  'utf-8',
  'utf-8-sig',
  'utf-16',
  'utf-16-le',
  'utf-16-be',
  'latin-1',
  'cp1252',
  'ascii',
  'mac-roman',
]);

const ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf8-sig': 'utf-8-sig',
  utf16: 'utf-16',
  'utf-16le': 'utf-16-le',
  utf16le: 'utf-16-le',
  'utf-16be': 'utf-16-be',
  utf16be: 'utf-16-be',
  latin1: 'latin-1',
  'iso-8859-1': 'latin-1',
  'windows-1252': 'cp1252',
  '1252': 'cp1252',
  ascii: 'ascii',
  'mac_roman': 'mac-roman',
  macintosh: 'mac-roman',
};

export function normalizeWorkspaceEncoding(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/_/g, '-');
  const n = ALIASES[t] ?? t;
  if (!ALLOWED.has(n)) {
    throw new Error(`Unsupported encoding: ${raw}`);
  }
  return n;
}

/** Decode workspace file bytes to LF text (BOM stripped), the inverse of {@link encodeWorkspaceFileContent}. */
export function decodeWorkspaceFileContent(buf: Buffer, encoding: string): string {
  const enc = normalizeWorkspaceEncoding(encoding);
  let text: string;
  switch (enc) {
    case 'utf-8':
    case 'utf-8-sig':
      text = buf.toString('utf8');
      break;
    case 'latin-1':
      text = buf.toString('latin1');
      break;
    case 'ascii':
      text = buf.toString('ascii');
      break;
    case 'utf-16':
    case 'utf-16-le':
      text = buf.toString('utf16le');
      break;
    case 'utf-16-be':
      text = iconv.decode(buf, 'UTF-16BE');
      break;
    case 'cp1252':
      text = iconv.decode(buf, 'windows-1252');
      break;
    case 'mac-roman':
      text = iconv.decode(buf, 'macintosh');
      break;
    default:
      throw new Error(`Unhandled encoding: ${enc}`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.replace(/\r\n/g, '\n');
}

export function encodeWorkspaceFileContent(
  content: string,
  encoding: string,
  newline: 'lf' | 'crlf',
): Buffer {
  const enc = normalizeWorkspaceEncoding(encoding);
  const body = newline === 'crlf' ? content.replace(/\n/g, '\r\n') : content;

  switch (enc) {
    case 'utf-8':
      return Buffer.from(body, 'utf8');
    case 'utf-8-sig':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    case 'latin-1':
      return Buffer.from(body, 'latin1');
    case 'ascii':
      return Buffer.from(body, 'ascii');
    case 'utf-16-le':
      return Buffer.from(body, 'utf16le');
    case 'utf-16':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
    case 'utf-16-be':
      return iconv.encode(body, 'UTF-16BE');
    case 'cp1252':
      return iconv.encode(body, 'windows-1252');
    case 'mac-roman':
      return iconv.encode(body, 'macintosh');
    default:
      throw new Error(`Unhandled encoding: ${enc}`);
  }
}
