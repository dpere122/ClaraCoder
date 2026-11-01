import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MarkdownPipe } from './markdown.pipe';

const CAPTURE_URL = 'nemo-asset://capture/0123456789abcdef0123456789abcdef.png';

@Component({
  standalone: true,
  imports: [MarkdownPipe],
  template: '<div class="assistant-md" [innerHTML]="text | markdown"></div>',
})
class MarkdownHost {
  text = '';
}

function render(text: string): HTMLElement {
  const fixture = TestBed.createComponent(MarkdownHost);
  fixture.componentInstance.text = text;
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('.assistant-md')!;
}

describe('MarkdownPipe capture images', () => {
  it('renders a broker capture PNG through the real pipe and Angular innerHTML binding', () => {
    const el = render(`![Webpage screenshot](${CAPTURE_URL} "Captured page")`);
    const image = el.querySelector('img');
    expect(image?.getAttribute('src')).toBe(CAPTURE_URL);
    expect(image?.alt).toBe('Webpage screenshot');
    expect(image?.title).toBe('Captured page');
  });

  it('escapes markdown alt and title metadata rather than creating attributes or elements', () => {
    const el = render(`![A & B "quoted"](${CAPTURE_URL} "Title &quot; onerror=&quot;alert(1) &lt;img src=x&gt;")`);
    const image = el.querySelector('img')!;
    expect(el.querySelectorAll('img').length).toBe(1);
    expect(image.alt).toBe('A & B "quoted"');
    expect(image.title).toBe('Title " onerror="alert(1) <img src=x>');
    expect(image.getAttribute('onerror')).toBeNull();
    expect(el.innerHTML).toContain('&quot;');
  });

  it.each([
    'https://example.com/tracker.png',
    'http://example.com/tracker.png',
    '//example.com/tracker.png',
    '/tracker.png',
    'relative.png',
    'file:///C:/secret.png',
    'javascript:alert%281%29',
    'data:image/png;base64,AAAA',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'blob:https://example.com/image',
    'nemo-asset://workspace/?root=C:/&path=secret.png',
    'nemo-asset://capture/secret.png',
    'nemo-asset://capture/0123456789abcdef.png',
    'nemo-asset://capture/0123456789ABCDEF0123456789ABCDEF.png',
    'nemo-asset://capture/0123456789abcdef0123456789abcdef.svg',
    'nemo-asset://capture/../0123456789abcdef0123456789abcdef.png',
    'nemo-asset://capture/%300123456789abcdef0123456789abcdef.png',
    'nemo-asset://capture@evil.example/0123456789abcdef0123456789abcdef.png',
    `${CAPTURE_URL}?path=secret.png`,
    `${CAPTURE_URL}#fragment`,
  ])('rejects markdown image source %s', (src) => {
    const el = render(`![Blocked image](${src})`);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('Blocked image');
  });

  it.each([
    '<img src="https://example.com/tracker.png" alt="Remote">',
    '<IMG SRC="&#104;ttps://example.com/tracker.png" ALT="Entity URL">',
    '<img src="file:///C:/secret.png" onerror="alert(1)">',
    '<img src="javascript:alert(1)">',
    '<img src="nemo-asset://workspace/?path=secret.png">',
    '<img srcset="https://example.com/tracker.png 1x">',
    '<noscript><img src="https://example.com/tracker.png"></noscript>',
    '<svg><image href="https://example.com/tracker.png"></image></svg>',
    '<math><mtext><img src="https://example.com/tracker.png"></mtext></math>',
    `<img src="${CAPTURE_URL}&#10;">`,
    `<img src="${CAPTURE_URL}&#13;">`,
    `<img src=" ${CAPTURE_URL}">`,
    `<img src="${CAPTURE_URL} ">`,
  ])('rejects raw HTML image bypass: %s', (html) => {
    const el = render(html);
    expect(el.querySelector('img, image')).toBeNull();
    expect(el.querySelector('[srcset]')).toBeNull();
  });

  it('keeps a safe raw capture but strips image attributes and picture srcset overrides', () => {
    const el = render(`<picture><source srcset="https://example.com/tracker.png 2x"><img src="${CAPTURE_URL}" srcset="https://example.com/tracker.png 1x" alt="A &quot;quote&quot; &amp; &lt;img src=x&gt;" title="&quot; onerror=&quot;alert(1)" onerror="alert(1)" width="9000" height="1" style="width:9000px"></picture>`);
    const image = el.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(CAPTURE_URL);
    expect(image.alt).toBe('A "quote" & <img src=x>');
    expect(image.title).toBe('" onerror="alert(1)');
    expect([...image.attributes].map((attribute) => attribute.name).sort()).toEqual(['alt', 'src', 'title']);
    expect(el.querySelectorAll('img').length).toBe(1);
    expect(el.querySelector('[srcset]')).toBeNull();
  });

  it('removes remote video posters as another image-fetching attribute', () => {
    expect(render('<video poster="https://example.com/tracker.png"></video>').querySelector('[poster]')).toBeNull();
  });

  it('keeps Angular sanitization for active HTML and preserves normal markdown', () => {
    const el = render('###Heading\n\n**Bold** and [documentation](https://example.com/docs).\n\n<script>alert(1)</script><iframe src="https://example.com"></iframe><p onclick="alert(1)">Text</p>');
    expect(el.querySelector('h3')?.textContent).toBe('Heading');
    expect(el.querySelector('strong')?.textContent).toBe('Bold');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
    expect(el.querySelector('script, iframe, [onclick]')).toBeNull();
  });

  it('does not turn image-looking code samples into images', () => {
    const el = render('```html\n<img src="https://example.com/tracker.png">\n```');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toContain('<img src="https://example.com/tracker.png">');
  });
});
