/** Strip trailing slashes; remove common OpenAI path suffixes if pasted by mistake. */
export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  url = url.replace(/\/v1\/audio\/speech\/?$/i, '');
  url = url.replace(/\/v1\/audio\/?$/i, '');
  if (url.toLowerCase().endsWith('/v1')) {
    url = url.slice(0, -3);
    while (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
  }
  return url;
}
