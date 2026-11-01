// Run under Node: node scripts/verify-screenshot-browser.mjs [--live]
// Hermetic mode exercises real sandboxed Chromium/protocol handling with an in-memory
// fixture. --live additionally verifies the pinned public HTTPS transport against example.com.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'clara-screenshot-smoke-'));
const entry = join(directory, 'smoke.cjs');
const root = resolve(import.meta.dirname, '..');
const fixture = '<!doctype html><html><body style="margin:0;background:rgb(12,160,80)"><h1>Safe screenshot fixture</h1><script>document.body.style.background="red"</script></body></html>';
try {
  buildSync({
    stdin: {
      resolveDir: root,
      sourcefile: 'screenshot-smoke.ts',
      contents: `
        import { app, nativeImage } from 'electron';
        import { strict as assert } from 'node:assert';
        import { captureWebpage } from './src/main/web/screenshot-browser';
        import { captureAssetResponse } from './src/main/web/screenshot-assets';
        import { CaptureNetwork } from './src/main/web/screenshot-network';
        app.setPath('appData', ${JSON.stringify(directory)});
        app.disableHardwareAcceleration();
        // Capturing destroys its only hidden window; keep the smoke app alive for assertions.
        app.on('window-all-closed', () => {});
        app.whenReady().then(async () => {
          const live = ${process.argv.includes('--live')};
          let liveFetched = false;
          if (!live) {
            CaptureNetwork.prototype.fetch = async () => new Response(${JSON.stringify(fixture)}, { headers: { 'Content-Type': 'text/html' } });
          } else {
            const transport = CaptureNetwork.prototype.fetch;
            CaptureNetwork.prototype.fetch = async function(url) {
              const response = await transport.call(this, url);
              if (url === 'https://example.com/') liveFetched = response.status === 200 && (await response.clone().text()).includes('Example Domain');
              return response;
            };
          }
          const result = await captureWebpage({ url: live ? 'https://example.com/' : 'https://capture.example.test/', width: 800, height: 600, user_agent: 'ClaraCoder-Screenshot-Test/1.0' });
          if (live) assert.ok(liveFetched, 'Pinned HTTPS transport must deliver the actual example.com page, not a blocked response');
          const response = await captureAssetResponse(result.image_url);
          assert.equal(response.status, 200);
          const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
          assert.deepEqual(image.getSize(), { width: 800, height: 600 });
          if (!live) {
            // Native bitmaps are BGRA. Bottom-right is plain fixture background;
            // red would prove page JavaScript executed despite our secure settings.
            const pixels = image.toBitmap();
            const last = pixels.subarray(pixels.length - 4);
            assert.deepEqual([...last], [80, 160, 12, 255]);
            // A direct image URL must also rasterize through Chromium, not become an embed.
            const samplePng = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toPNG();
            CaptureNetwork.prototype.fetch = async () => new Response(new Uint8Array(samplePng), { headers: { 'Content-Type': 'image/png' } });
            const direct = await captureWebpage({ url: 'https://capture.example.test/picture.png', width: 800, height: 600, user_agent: 'Test/1.0' });
            const directResponse = await captureAssetResponse(direct.image_url);
            const directImage = nativeImage.createFromBuffer(Buffer.from(await directResponse.arrayBuffer()));
            assert.deepEqual(directImage.getSize(), { width: 800, height: 600 });
            assert.ok(directImage.toBitmap().includes(Buffer.from([255, 0, 0, 255])), 'Direct PNG must appear in the raster capture');
          }
          await assert.rejects(() => captureWebpage({ url: 'http://127.0.0.1/', width: 800, height: 600, user_agent: 'Test/1.0' }));
          console.log('SCREENSHOT_SMOKE_OK', JSON.stringify(result));
          app.exit(0);
        }).catch((error) => { console.error(error); app.exit(1); });
      `,
    },
    outfile: entry,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    logLevel: 'warning',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('Running real Electron screenshot smoke test', process.argv.includes('--live') ? '(public HTTPS)' : '(fixture)');
  const result = spawnSync(require('electron'), [entry], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status === 0 && !result.stdout?.includes('SCREENSHOT_SMOKE_OK')) {
    throw new Error('Electron exited without completing the screenshot assertions.');
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
