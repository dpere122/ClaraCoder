import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), http: vi.fn(), https: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.http }));
vi.mock('node:https', () => ({ request: mocks.https }));

import { CaptureNetwork, captureUrl, captureUserAgent, isPublicCaptureAddress, resolveCaptureAddress } from './screenshot-network';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('screenshot public network boundary', () => {
  it.each([
    '127.0.0.1', '0.0.0.0', '10.2.3.4', '100.100.100.200', '169.254.169.254',
    '172.20.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1',
    'fc00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::',
    'not-an-ip',
  ])('blocks non-public or special-use address %s', (ip) => {
    expect(isPublicCaptureAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('accepts public IP %s', (ip) => {
    expect(isPublicCaptureAddress(ip)).toBe(true);
  });

  it.each([
    'file:///C:/secret', 'data:text/html,secret', 'javascript:alert(1)', 'ftp://example.com',
    'https://user:password@example.com', 'http://0x7f000001', 'http://2130706433',
    'http://[::ffff:127.0.0.1]', 'https://example.com:3000/',
    'https://example.com/?email=user%40example.com',
    'https://example.com/?email=user%2540example.com',
    'https://example.com/path\nheader',
    'https://example.com/path%250aheader', 'https://example.com/%255csecret',
    'https://example.com/?email=user%252525252540example.com',
  ])('rejects dangerous URL %s', (raw) => {
    expect(() => captureUrl(raw)).toThrow();
  });

  it('validates all DNS answers, not just the first one', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]);
    await expect(resolveCaptureAddress('mixed.example', resolver)).rejects.toThrow('Non-public');
  });

  it('returns a pinned IP without a second DNS lookup', async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(resolveCaptureAddress('public.example', resolver)).resolves.toBe('8.8.8.8');
    expect(resolver).toHaveBeenCalledTimes(1);
    await expect(resolveCaptureAddress('127.0.0.1', resolver)).rejects.toThrow();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it.each(['bad\r\nX-Header: injected', 'Contact user@example.com', '', 'x'.repeat(513), 'UA/λ'])('rejects unsafe UA %s', (ua) => {
    expect(() => captureUserAgent(ua)).toThrow();
  });

  it('connects to the validated address with original TLS SNI and only safe headers', async () => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; setTimeout: () => void; destroy: () => void };
    request.setTimeout = vi.fn();
    request.destroy = vi.fn();
    const response = new EventEmitter() as EventEmitter & { headers: object; statusCode: number };
    response.headers = { 'content-type': 'text/html', 'set-cookie': 'secret=yes', 'content-disposition': 'attachment' };
    response.statusCode = 200;
    mocks.https.mockImplementation((_options, callback) => {
      request.end = () => {
        callback(response);
        response.emit('data', Buffer.from('<h1>hello</h1>'));
        response.emit('end');
      };
      return request;
    });
    const network = new CaptureNetwork('Capture-Test/1.0');
    const result = await network.fetch('https://example.com/page');
    const options = mocks.https.mock.calls[0][0];
    expect(options.hostname).toBe('93.184.216.34');
    expect(options.servername).toBe('example.com');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers.Host).toBe('example.com');
    expect(options.headers['User-Agent']).toBe('Capture-Test/1.0');
    expect(options.headers.Cookie).toBeUndefined();
    expect(options.headers.Authorization).toBeUndefined();
    expect(result.headers.has('Set-Cookie')).toBe(false);
    expect(result.headers.has('Content-Disposition')).toBe(false);
    expect(result.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
    expect(await result.text()).toContain('hello');
    network.close();
    expect(request.destroy).toHaveBeenCalled();
    await expect(network.fetch('https://example.com')).rejects.toThrow('budget');
  });

  it('blocks a redirect to a private IP before Chromium receives a Location header', async () => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; setTimeout: () => void };
    request.setTimeout = vi.fn();
    mocks.http.mockImplementation((_options, callback) => {
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & { headers: object; statusCode: number };
        response.headers = { location: 'http://169.254.169.254/metadata' };
        response.statusCode = 302;
        callback(response);
        response.emit('end');
      };
      return request;
    });
    await expect(new CaptureNetwork('Capture-Test/1.0').fetch('http://example.com')).rejects.toThrow('Non-public');
  });
});
