'use strict';

// Build first, in order: node node_modules/typescript/bin/tsc -p ./
//                        node scripts/run-ng.mjs build
// After both succeed: node scripts/run-electron.mjs electron scripts/tutorial-smoke.cjs
// This is an Electron MAIN entry point, not a Node or browser-bridge test. It runs the
// compiled app with disposable data, real windows/preload/tutorial IPC, and offline fixtures.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const spawnCleanup = childProcess.spawn;
const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require('electron');

if (!process.versions.electron || !app) {
  throw new Error('Run this under Electron via node scripts/run-electron.mjs electron scripts/tutorial-smoke.cjs');
}

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const required = [
  'main/index.js',
  'main/config/defaults.js',
  'main/state.js',
  'preload/preload.js',
  'renderer/browser/index.html',
];
const missing = required.filter((name) => !fs.existsSync(path.join(dist, name)));
if (missing.length) {
  console.error(`[tutorial-smoke] Missing production build: ${missing.join(', ')}`);
  app.exit(1);
} else {
  void boot().catch((error) => {
    console.error('[tutorial-smoke] Bootstrap failed:', error);
    app.exit(1);
  });
}

async function boot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-tutorial-smoke-'));
  const appData = path.join(tempRoot, 'app-data');
  const userData = path.join(appData, app.isPackaged ? 'clara-coder' : 'clara-coder-dev');
  const sessionData = path.join(tempRoot, 'session');
  const home = path.join(tempRoot, 'home');
  const temp = path.join(tempRoot, 'tmp');
  const models = path.join(tempRoot, 'models');
  const crashDumps = path.join(tempRoot, 'crash-dumps');
  const configFile = path.join(userData, 'config.json');
  // Optional visual inspection of this isolated fixture; no user data is captured.
  const captureDir = process.env.TUTORIAL_SMOKE_SCREENSHOT_DIR
    ? path.resolve(root, process.env.TUTORIAL_SMOKE_SCREENSHOT_DIR)
    : null;
  const attempts = { unsafeIpc: [], settingsSaves: [], subprocesses: [], network: [], external: [] };
  const calls = new Map();
  const registrations = new Set();
  const depsGate = deferred();
  const detailsGate = deferred();
  const filesGate = deferred();
  let state;
  let llamaInstalled = false;
  let allowFakeLlamaInstall = false;
  let fakeLlamaInstalls = 0;
  let allowSettingsSave = false;
  let approvedSettingsSaves = 0;
  let finished = false;
  let watchdog;

  // Destroying the last window normally quits immediately; finish cleanup first instead.
  app.on('before-quit', (event) => event.preventDefault());
  process.on('uncaughtException', (error) => void finish(1, error));
  process.on('unhandledRejection', (error) => void finish(1, error));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void finish(1, new Error(`Received ${signal}`)));
  }
  watchdog = setTimeout(() => void finish(1, new Error('Global 150-second smoke timeout')), 150_000);

  try {
    // Never inherit a dev bridge, real provider credentials, model commands, or local paths.
    for (const key of Object.keys(process.env)) {
      if (/^(CLARA_|NEMO_|LM_STUDIO_|LLAMACPP_|LLAMA_SERVER_|OPENROUTER_|OPENAI_|ANTHROPIC_|HF_|HUGGING_FACE_|HUGGINGFACE_|TRANSFORMERS_)/i.test(key)) {
        delete process.env[key];
      }
    }
    delete process.env.DEV_SERVER_URL;
    for (const dir of [appData, userData, sessionData, home, temp, models, crashDumps]) fs.mkdirSync(dir, { recursive: true });
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: path.join(tempRoot, 'local-app-data'),
      XDG_CONFIG_HOME: path.join(tempRoot, 'xdg-config'),
      XDG_CACHE_HOME: path.join(tempRoot, 'xdg-cache'),
      XDG_DATA_HOME: path.join(tempRoot, 'xdg-data'),
      XDG_STATE_HOME: path.join(tempRoot, 'xdg-state'),
      TMP: temp,
      TEMP: temp,
      CLARA_CUSTOM_MODELS_DIR: models,
      HF_HOME: path.join(tempRoot, 'hf'),
      HF_HUB_OFFLINE: '1',
    });

    // This must precede *every* compiled main module, including config/defaults.
    app.setPath('appData', appData);
    app.setPath('userData', userData);
    app.setPath('sessionData', sessionData);
    app.setPath('home', home);
    app.setPath('temp', temp);
    app.setPath('crashDumps', crashDumps);
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
    app.commandLine.appendSwitch('disable-http-cache');

    // Avoid even checking the user's OS keychain. Our seeded credentials are synthetic.
    safeStorage.isEncryptionAvailable = () => false;
    safeStorage.encryptString = () => { throw new Error('tutorial-smoke keychain access blocked'); };
    safeStorage.decryptString = () => { throw new Error('tutorial-smoke keychain access blocked'); };
    shell.openExternal = async (url) => { attempts.external.push(String(url)); };
    shell.openPath = async () => '';
    shell.showItemInFolder = () => {};

    // Defence in depth: no sidecar, runtime installer, model process, or network call
    // may escape even if a future startup path bypasses the IPC fixtures below.
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[method] = () => {
        const error = new Error(`tutorial-smoke blocked child_process.${method}`);
        attempts.subprocesses.push(error.stack?.split('\n').slice(0, 6).join('\n') ?? method);
        throw error;
      };
    }
    globalThis.fetch = async () => {
      attempts.network.push('fetch');
      throw new Error('tutorial-smoke is offline');
    };
    for (const moduleName of ['node:http', 'node:https']) {
      const transport = require(moduleName);
      for (const method of ['request', 'get']) {
        transport[method] = () => {
          attempts.network.push(`${moduleName}.${method}`);
          throw new Error('tutorial-smoke is offline');
        };
      }
    }
    const net = require('node:net');
    net.Socket.prototype.connect = function blockedConnect() {
      attempts.network.push('socket.connect');
      throw new Error('tutorial-smoke is offline');
    };

    // systeminformation probes `chcp` as an import-time side effect on Windows.
    // Its health IPC is mocked below, so even that harmless OS subprocess is unnecessary.
    require(path.join(path.dirname(require.resolve('systeminformation')), 'util.js')).getCodepage = () => '65001';

    const defaults = require(path.join(dist, 'main/config/defaults.js'));
    const initialConfig = defaults.createDefaultConfig();
    initialConfig.modelManager.customModelsDir = models;
    initialConfig.modelManager.huggingFaceToken = '';
    initialConfig.audioTranscription.apiKey = '';
    initialConfig.audioTranscription.ttsApiKey = '';
    for (const provider of initialConfig.llmProviders) provider.apiKey = '';
    // SecretValue.toJSON redacts defaults; unwrap this freshly generated, scrubbed
    // seed for valid JSON. No secret is copied from the user's config.
    const seed = JSON.stringify(initialConfig, function serializeSeed(key, value) {
      const original = this[key];
      return original && typeof original.unwrap === 'function' ? original.unwrap() : value;
    }, 2);
    fs.writeFileSync(configFile, seed, { encoding: 'utf8', mode: 0o600 });
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).modelManager.customModelsDir, models);

    state = require(path.join(dist, 'main/state.js')).mainState;
    const catalog = require(path.join(dist, 'shared/types/dependencies.js')).defaultDependencyCatalog();
    const listDependencies = () => ({
      ok: true,
      dependencies: catalog.map((item) => item.id === 'llama-server' && llamaInstalled
        ? { ...item, state: 'installed', version: 'fixture', path: path.join(tempRoot, 'runtime', 'llama-server') }
        : { ...item }),
    });

    const idle = async () => {};
    const noop = () => {};
    patch('main/python/server.js', {
      ensurePythonServer: idle,
      ensurePythonReady: idle,
      isPythonHealthy: async () => false,
      stopPythonSidecar: noop,
    });
    patch('main/python/workspace-sync.js', {
      syncRuntimeConfigToPython: idle,
      syncWorkspaceContextToPython: idle,
      syncWorkspaceSystemPromptToPython: idle,
    });
    patch('main/python/http-client.js', {
      pythonControlFetch: async (route) => {
        if (route === '/load') return { ok: true, json: async () => ({}) };
        throw new Error('tutorial-smoke sidecar is disabled');
      },
      pythonLongFetch: async () => { throw new Error('tutorial-smoke sidecar is disabled'); },
    });
    patch('main/runtime/user-path.js', { applyResolvedUserPath: idle });
    patch('main/llama-server-manager.js', { reapOrphanManagedLlamaServers: idle, stopAllManagedLlamaServers: noop });
    patch('main/ipc/handlers/health.js', { setHealthMetricsEnabled: noop, syncPythonLogLevel: idle });
    patch('main/workspace/watcher.js', {
      clearWorkspaceWatcher: noop,
      refreshWorkspaceWatcherForCurrentConfig: idle,
      applyWorkspaceExposeAllFromConfig: idle,
    });
    patch('main/mcp-oauth-refresh.js', { rearmMcpOAuthRefresh: noop });
    patch('main/ipc/handlers/subagent-events.js', { startSubagentEventPump: noop, stopSubagentEventPump: noop });
    patch('main/web/screenshot-maintenance.js', { startScreenshotMaintenance: noop, stopScreenshotMaintenance: noop });
    patch('main/dev/browser-bridge.js', { captureIpcForBrowserBridge: noop, startBrowserBridge: idle });

    const blocked = new Set([
      'deps:install', 'deps:reinstall', 'deps:delete', 'deps:cancel', 'deps:reveal',
      'model-manager:download-hf-file', 'model-manager:cancel-hf-download',
      'model-manager:rename-model', 'model-manager:delete-model', 'model-manager:pick-custom-dir',
      'llama-server:start', 'llama-server:stop', 'lm-studio:load-model', 'lm-studio:unload-model',
      'updater:download', 'updater:install-now', 'updater:install-on-quit',
    ]);
    const fixtures = {
      'deps:list': async (event) => {
        // Home can finish startup; hold only the actual Dependencies window's response.
        if (roleOf(event.sender) === 'dependencies') await depsGate.promise;
        return listDependencies();
      },
      'model-manager:secret-storage': () => 'plaintext',
      'model-manager:list-custom-models': (_event, payload) => {
        assert.equal(path.resolve(payload.customDir), models, 'model scan must stay in the temp library');
        return { ok: true, models: [], resolvedDir: models };
      },
      'model-manager:search-hf': () => ({ ok: true, models: [], hasMore: false, skip: 0, limit: 20, totalCount: 0, totalPages: 0 }),
      'model-manager:hf-model-details': async (_event, payload) => {
        await detailsGate.promise;
        return { ok: true, details: fakeDetails(payload.id) };
      },
      'model-manager:list-hf-files': async () => {
        await filesGate.promise;
        return { ok: true, files: [{ fileName: 'smoke-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 1_234 }] };
      },
      'health-runtime-snapshot': () => ({
        timestampMs: Date.now(), python: { healthy: false }, dependencies: catalog,
        llama: { binaryInstalled: false, runningCount: 0, health: 'stopped' },
        lsp: { javaInstalled: false, vtslsInstalled: false, activeSessions: 0 },
      }),
      'health-metrics': () => ({
        timestampMs: Date.now(), memoryUsedBytes: 0, memoryTotalBytes: 0, memoryUsedPercent: 0,
        cpuLoadPercent: 0, networkRxBps: 0, networkTxBps: 0, diskReadBps: 0, diskWriteBps: 0, gpus: [],
      }),
      'gpu-cuda-inventory': () => [],
      'list-system-fonts': () => [],
      'llama-server:vram-usage': () => [],
      'llama-server:status': () => ({ ok: false, error: 'No smoke server' }),
      'llama-server:chat-template-reasoning': (_event, payload) => ({ ok: true, modelId: payload?.modelId, chatTemplateReasoning: null, nCtx: null }),
      'llamacpp-managed:list-models': () => ({ ok: false, error: 'No smoke server' }),
      'llamacpp-openai:list-models': () => ({ ok: true, models: [] }),
      'lm-studio:list-models': () => ({ ok: true, origin: 'http://fixture.invalid', source: 'v1', models: [] }),
      'openrouter:list-models': () => ({ ok: true, models: [] }),
      'anthropic:status': () => ({ ok: true, status: { configured: false, storage: 'plaintext', keyHint: '', models: [] } }),
      'embeddings:status': () => ({ ok: false, error: 'No smoke sidecar' }),
      'sync-auto-apply-mode': () => ({ ok: true }),
      'sync-admin-elevation': () => ({ ok: true }),
      'updater:list-releases': () => ({ ok: true, currentVersion: '0.0.0', releases: [] }),
    };

    // Install before main's synchronous registerAllIpc(). The real tutorial/config
    // handlers are intentionally NOT mocked: ownership and persistence are the subject.
    const register = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => {
      registrations.add(channel);
      return register(channel, async (event, ...args) => {
        calls.set(channel, (calls.get(channel) ?? 0) + 1);
        if (channel === 'deps:install' && allowFakeLlamaInstall) {
          assert.equal(roleOf(event.sender), 'dependencies');
          assert.equal(args[0], 'llama-server');
          allowFakeLlamaInstall = false;
          fakeLlamaInstalls++;
          llamaInstalled = true; // Fixture only: no process is spawned and no file is downloaded.
          return { ok: true };
        }
        if (blocked.has(channel)) {
          attempts.unsafeIpc.push(channel);
          return channel === 'model-manager:pick-custom-dir' ? null : { ok: false, error: 'Blocked by tutorial smoke' };
        }
        if (channel === 'save-config' && roleOf(event.sender) === 'settings') {
          if (!allowSettingsSave) {
            attempts.settingsSaves.push(channel);
            throw new Error('Settings Apply was not requested by the smoke test');
          }
          approvedSettingsSaves++;
        }
        if (Object.prototype.hasOwnProperty.call(fixtures, channel)) return fixtures[channel](event, ...args);
        return handler(event, ...args);
      });
    };

    // Register before the compiled entry's own whenReady callback creates a window.
    const isolationReady = app.whenReady().then(() => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const blockedUrl = /^(https?|wss?):/i.test(details.url);
        if (blockedUrl) attempts.network.push('renderer request');
        callback({ cancel: blockedUrl });
      });
      session.defaultSession.on('will-download', (event) => {
        attempts.unsafeIpc.push('Chromium will-download');
        event.preventDefault();
      });
    });
    require(path.join(dist, 'main/index.js'));
    for (const channel of ['tutorial:get-snapshot', 'tutorial:claim', 'tutorial:release', 'tutorial:transition', 'deps:list', 'model-manager:hf-model-details']) {
      assert.ok(registrations.has(channel), `Compiled app did not register ${channel}; rebuild the current sources`);
    }
    assert.equal(path.resolve(app.getPath('appData')), appData);
    assert.equal(path.resolve(app.getPath('userData')), userData);
    await isolationReady;
    await runTour();
    await finish(0);
  } catch (error) {
    await finish(1, error);
  }

  function patch(relative, replacements) {
    const exports = require(path.join(dist, relative));
    for (const [name, replacement] of Object.entries(replacements)) {
      assert.equal(typeof exports[name], 'function', `Missing safety hook ${relative}:${name}; rebuild/check app architecture`);
      exports[name] = replacement;
    }
  }

  function roleOf(contents) {
    if (state?.mainWindow?.webContents === contents) return 'home';
    if (state?.dependenciesWindow?.webContents === contents) return 'dependencies';
    if (state?.settingsWindow?.webContents === contents) return 'settings';
    return 'other';
  }

  function windowFor(role) {
    const win = role === 'home' ? state.mainWindow : role === 'dependencies' ? state.dependenciesWindow : state.settingsWindow;
    return win && !win.isDestroyed() ? win : null;
  }

  async function waitWindow(role) {
    return waitFor(`${role} BrowserWindow`, async () => {
      const win = windowFor(role);
      if (!win || win.webContents.isLoadingMainFrame() || !win.webContents.getURL()) return null;
      return (await evaluate(win, () => !!Reflect.get(window, 'electronAPI')?.getTutorialSnapshot)) ? win : null;
    });
  }

  async function snapshot(win) {
    return evaluate(win, () => Reflect.get(window, 'electronAPI').getTutorialSnapshot());
  }

  async function capture(win, name, waitMs = 0) {
    if (!captureDir) return;
    if (waitMs) await delay(waitMs);
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, `${name}.png`), (await win.capturePage()).toPNG());
  }

  async function card(win) {
    return evaluate(win, () => {
      const box = document.querySelector('app-tutorial-overlay .tutorial-card');
      if (!box) return null;
      const primary = box.querySelector('button.tutorial-button--primary');
      return {
        title: box.querySelector('#tutorial-title')?.textContent?.trim() ?? '',
        eyebrow: box.querySelector('.tutorial-eyebrow')?.textContent?.trim() ?? '',
        text: box.textContent?.replace(/\s+/g, ' ').trim().slice(0, 900) ?? '',
        primary: primary?.textContent?.trim() ?? '',
        disabled: !primary || primary.disabled,
      };
    });
  }

  async function expectStep(win, phaseId, stepId, title) {
    const result = await waitFor(`${roleOf(win.webContents)} ${phaseId}/${stepId} (${title})`, async () => {
      if (win.isDestroyed()) return null;
      const [current, visible] = await Promise.all([snapshot(win), card(win)]);
      return current?.progress?.active?.phaseId === phaseId && current.progress.active.stepId === stepId &&
        current.ownerId === win.webContents.id && visible?.title === title ? current : null;
    });
    const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(disk.tutorial, result.progress, `Disk did not persist ${phaseId}/${stepId}`);
    return result;
  }

  async function expectHighlight(win, selector) {
    await waitFor(`tutorial highlights ${selector}`, () => evaluate(win, (query) => {
      const target = document.querySelector(query);
      const outline = document.querySelector('app-tutorial-overlay .tutorial-highlight');
      if (!target || !outline) return false;
      const expected = target.getBoundingClientRect();
      const actual = outline.getBoundingClientRect();
      return Math.abs(expected.left - actual.left) < 3 && Math.abs(expected.top - actual.top) < 3 &&
        Math.abs(expected.width - actual.width) < 3 && Math.abs(expected.height - actual.height) < 3;
    }, selector));
  }

  async function clickPrimary(win, expected) {
    const info = await waitFor(`enabled tutorial action ${expected}`, async () => {
      const current = await card(win);
      return current && !current.disabled && expected.test(current.primary) ? current : null;
    });
    const clicked = await evaluate(win, (label) => {
      const button = document.querySelector('app-tutorial-overlay .tutorial-card button.tutorial-button--primary');
      if (!button || button.disabled || button.textContent.trim() !== label) return false;
      button.click();
      return true;
    }, info.primary);
    assert.ok(clicked, `Tutorial button changed before click: ${info.primary}`);
  }

  async function clickTarget(win, selector) {
    await waitFor(`visible target ${selector}`, () => evaluate(win, (query) => {
      const element = document.querySelector(query);
      return !!element && !element.disabled && element.getClientRects().length > 0;
    }, selector));
    assert.ok(await evaluate(win, (query) => {
      const element = document.querySelector(query);
      if (!element || element.disabled) return false;
      element.click();
      return true;
    }, selector), `Could not click ${selector}`);
  }

  async function restartHome(win) {
    win.destroy();
    await waitFor('old Home window destroyed', async () => !windowFor('home'));
    require(path.join(dist, 'main/windows/main-window.js')).createMainWindow();
    const next = await waitWindow('home');
    await waitFor('restarted Home Angular shell', () => evaluate(next, () => !!document.querySelector('app-shell .app-top-bar')));
    return next;
  }

  async function reload(win) {
    const contents = win.webContents;
    const loaded = new Promise((resolve, reject) => {
      const cleanup = () => {
        contents.removeListener('did-finish-load', onFinish);
        contents.removeListener('did-fail-load', onFailure);
        contents.removeListener('render-process-gone', onGone);
      };
      const onFinish = () => { cleanup(); resolve(); };
      const onFailure = (_event, code, description, url, mainFrame) => {
        if (!mainFrame) return;
        cleanup();
        reject(new Error(`Renderer reload failed: ${code} ${description} ${url}`));
      };
      const onGone = (_event, details) => { cleanup(); reject(new Error(`Renderer gone: ${details.reason}`)); };
      contents.once('did-finish-load', onFinish);
      contents.on('did-fail-load', onFailure);
      contents.once('render-process-gone', onGone);
      contents.reload();
    });
    await bounded(loaded, 12_000, 'renderer reload');
    await waitFor('Home Angular shell after reload', () => evaluate(win, () =>
      !!Reflect.get(window, 'electronAPI')?.getTutorialSnapshot && !!document.querySelector('app-shell .app-top-bar')));
  }

  function rewriteProgress(progress) {
    const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(current.modelManager.customModelsDir, models);
    current.tutorial = progress;
    fs.writeFileSync(configFile, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async function setMotion(win, value) {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await bounded(win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }],
    }), 3_000, 'emulate reduced motion');
    await waitFor(`prefers-reduced-motion ${value}`, () => evaluate(win, (expectReduce) =>
      matchMedia('(prefers-reduced-motion: reduce)').matches === expectReduce, value === 'reduce'));
  }

  async function checkReducedMotion(win, celebration) {
    await setMotion(win, 'reduce');
    const styles = await waitFor('rendered tutorial mascot', () => evaluate(win, () => {
      const mascot = document.querySelector('.tutorial-mascot');
      const mark = document.querySelector('.tutorial-mascot__mark');
      const sparkles = document.querySelector('.tutorial-mascot__sparkles');
      if (!mascot || !mark) return null;
      return {
        animation: getComputedStyle(mascot).animationName,
        markOpacity: getComputedStyle(mark).opacity,
        sparkles: sparkles ? getComputedStyle(sparkles).display : null,
      };
    }));
    assert.equal(styles.animation, 'none');
    assert.equal(styles.markOpacity, '1');
    if (celebration) assert.equal(styles.sparkles, 'none');
    await setMotion(win, 'no-preference');
  }

  async function runTour() {
    let homeWindow = await waitWindow('home');
    const initial = await waitFor('fresh tour invitation', async () => {
      const [visible, current] = await Promise.all([card(homeWindow), snapshot(homeWindow)]);
      return visible?.primary === 'Start tour' && current?.progress?.revision === 0 &&
        current.progress.active === null && current.ownerId === homeWindow.webContents.id ? current : null;
    });
    assert.deepEqual(initial.progress.phases, {});
    console.log('[tutorial-smoke] PASS fresh invitation and isolated config');

    const dismissed = await evaluate(homeWindow, () => {
      const buttons = [...document.querySelectorAll('app-tutorial-overlay .tutorial-card button')];
      const button = buttons.find((item) => item.textContent.toLowerCase().includes('show this tour again'));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    assert.ok(dismissed, 'Invitation has no enabled persistent dismiss action');
    const dismissedSnapshot = await waitFor('dismissal persisted', async () => {
      const current = await snapshot(homeWindow);
      return current.progress.active === null && current.ownerId === null &&
        ['intro', 'local-engine', 'featured-models', 'local-source'].every((id) => current.progress.phases[id] === 'dismissed') ? current : null;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).tutorial, dismissedSnapshot.progress);
    homeWindow = await restartHome(homeWindow);
    await delay(700);
    assert.equal(await card(homeWindow), null, 'Dismissed invitation returned after Home restart');
    assert.deepEqual((await snapshot(homeWindow)).progress, dismissedSnapshot.progress);
    console.log('[tutorial-smoke] PASS dismiss, disk persistence, and Home window restart');

    // A second fresh fixture enables a complete tour after testing permanent dismissal.
    rewriteProgress({ revision: dismissedSnapshot.progress.revision + 1, phases: {}, active: null });
    homeWindow = await restartHome(homeWindow);
    await waitFor('recreated fresh invitation', async () => (await card(homeWindow))?.primary === 'Start tour');
    homeWindow.show();
    homeWindow.focus();
    homeWindow.webContents.focus();
    await delay(150);
    const focused = await evaluate(homeWindow, () => {
      const button = document.querySelector('app-tutorial-overlay .tutorial-button--primary');
      button?.focus();
      return document.activeElement === button;
    });
    assert.ok(focused, 'Start tour must be keyboard-focusable');
    homeWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    homeWindow.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    homeWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await expectStep(homeWindow, 'intro', 'welcome', 'Welcome to Clara Coder');
    console.log('[tutorial-smoke] PASS keyboard activation');
    await checkReducedMotion(homeWindow, false);
    console.log('[tutorial-smoke] PASS reduced-motion mascot');

    const homeSteps = [
      ['home-start', 'Start here'],
      ['home-workspace', 'Your workspace'],
      ['home-navigation', 'Model sources'],
      ['home-models', 'Your model library'],
      ['home-dependencies', 'Optional local engine'],
    ];
    for (const [step, title] of homeSteps) {
      // The fade is too brief to poll for, so record its end from before the click.
      if (step === 'home-workspace') {
        await evaluate(homeWindow, () => {
          document.addEventListener('animationend', (event) => {
            if (event.target.classList?.contains('tutorial-mascot-departure')) window.__tutorialDeparture = event.animationName;
          }, { capture: true });
        });
      }
      await clickPrimary(homeWindow, /^(next|continue anyway)$/i);
      await expectStep(homeWindow, 'intro', step, title);
      if (step === 'home-start') {
        await capture(homeWindow, 'home-fading-in', 200);
        await capture(homeWindow, 'home-settled', 1400);
      }
      if (step === 'home-workspace') {
        const departure = await waitFor('mascot fade-out finished', () => evaluate(homeWindow, () => {
          const name = window.__tutorialDeparture;
          return name && !document.querySelector('.tutorial-mascot-departure') && document.querySelector('.tutorial-mascot') ? name : null;
        }));
        assert.match(departure, /tutorial-mascot-fade-out/);
        console.log('[tutorial-smoke] PASS mascot fades out of its previous location');
      }
      if (step === 'home-navigation') await expectHighlight(homeWindow, '[data-tutorial="home-sources"]');
      if (step === 'home-models') await expectHighlight(homeWindow, '[data-tutorial="home-model-manager"]');
    }
    await clickPrimary(homeWindow, /^open dependencies$/i);
    let dependenciesWindow = await waitWindow('dependencies');
    await expectStep(dependenciesWindow, 'local-engine', 'engine-intro', 'Meet llama-server');
    assert.equal((await snapshot(homeWindow)).ownerId, dependenciesWindow.webContents.id);
    await waitFor('asynchronous dependency checking state', () => evaluate(dependenciesWindow, () => {
      const target = document.querySelector('[data-tutorial="dependencies-llama"]');
      return target?.getAttribute('data-tutorial-llama-state') === 'checking' &&
        target.getAttribute('data-tutorial-dependencies-busy') === 'true';
    }));
    assert.ok((calls.get('deps:list') ?? 0) > 0, 'Dependency fixture was not requested');

    // Close the owner while the list is in flight; Home must reacquire and offer recovery.
    dependenciesWindow.close();
    await waitFor('closed dependency owner', async () => dependenciesWindow.isDestroyed());
    await waitFor('home recovery handoff', async () => {
      const [visible, current] = await Promise.all([card(homeWindow), snapshot(homeWindow)]);
      return current.progress.active?.stepId === 'engine-intro' &&
        /^(continue in|reopen) dependencies$/i.test(visible?.primary ?? '') ? current : null;
    });
    await clickPrimary(homeWindow, /^(continue in|reopen) dependencies$/i);
    dependenciesWindow = await waitWindow('dependencies');
    await expectStep(dependenciesWindow, 'local-engine', 'engine-intro', 'Meet llama-server');
    depsGate.resolve();
    await waitFor('dependency fixture missing state', () => evaluate(dependenciesWindow, () => {
      const target = document.querySelector('[data-tutorial="dependencies-llama"]');
      return target?.getAttribute('data-tutorial-llama-state') === 'missing' &&
        target.getAttribute('data-tutorial-dependencies-busy') === 'false';
    }));
    await clickPrimary(dependenciesWindow, /^(next|continue anyway)$/i);
    await expectStep(dependenciesWindow, 'local-engine', 'engine-install', 'Install if you want to');
    await waitFor('continue without installing action', async () => (await card(dependenciesWindow))?.primary === 'Continue without installing');

    // A synthetic, unowned completion must be shown as already installed, not as a
    // tour-started successful install. Then restore the missing fixture for the skip path.
    llamaInstalled = true;
    dependenciesWindow.webContents.send('deps:progress', { depId: 'llama-server', phase: 'done', message: 'Fixture already installed' });
    await waitFor('already-installed acknowledgement', () => evaluate(dependenciesWindow, () => {
      const target = document.querySelector('[data-tutorial="dependencies-llama"]');
      return target?.getAttribute('data-tutorial-llama-state') === 'installed' &&
        target.getAttribute('data-tutorial-dependencies-busy') === 'false';
    }));
    await waitFor('already-installed explanation', async () => (await card(dependenciesWindow))?.text.includes('already installed'));
    llamaInstalled = false;
    dependenciesWindow.webContents.send('deps:progress', { depId: 'llama-server', phase: 'done', message: 'Fixture missing again' });
    await waitFor('missing dependency after refresh', () => evaluate(dependenciesWindow, () =>
      document.querySelector('[data-tutorial="dependencies-llama"]')?.getAttribute('data-tutorial-llama-state') === 'missing'));
    await clickPrimary(dependenciesWindow, /^continue without installing$/i);
    await expectStep(homeWindow, 'featured-models', 'home-model-manager', 'Explore models');
    assert.ok(!dependenciesWindow.isDestroyed(), 'Continuing without an install must leave Dependencies open');
    console.log('[tutorial-smoke] PASS dependency handoff, delayed/missing/installed fixtures, owner-close recovery, no install');

    await clickPrimary(homeWindow, /^open model manager$/i);
    let settingsWindow = await waitWindow('settings');
    await expectStep(settingsWindow, 'featured-models', 'featured-intro', 'Featured models');
    assert.equal((await snapshot(homeWindow)).ownerId, settingsWindow.webContents.id);
    await waitFor('home overlay hidden during settings ownership', async () => (await card(homeWindow)) === null);
    for (const [step, title] of [['featured-small', 'A smaller example'], ['featured-largest', 'Compare a larger model'], ['featured-preview', 'Preview model details']]) {
      await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
      await expectStep(settingsWindow, 'featured-models', step, title);
    }
    await waitFor('metadata and quantization IPC fixtures requested', async () =>
      (calls.get('model-manager:hf-model-details') ?? 0) > 0 && (calls.get('model-manager:list-hf-files') ?? 0) > 0);
    const loading = await waitFor('preview loading states', () => evaluate(settingsWindow, () => {
      const panel = document.querySelector('.mm-panel');
      const small = document.querySelector('[data-tutorial="featured-small"]');
      const quants = document.querySelector('[data-tutorial="featured-quantizations"]');
      if (panel?.getAttribute('data-details-state') !== 'loading' || quants?.getAttribute('data-state') !== 'loading') return null;
      return { repo: panel.getAttribute('data-repo-id'), small: small?.getAttribute('data-row-key') };
    }));
    assert.equal(`hf:${loading.repo}`, loading.small, 'Preview should select the featured Small example');
    detailsGate.resolve();
    await waitFor('model details ready while quantizations remain pending', () => evaluate(settingsWindow, () =>
      document.querySelector('.mm-panel')?.getAttribute('data-details-state') === 'ready' &&
      document.querySelector('[data-tutorial="featured-quantizations"]')?.getAttribute('data-state') === 'loading'));
    filesGate.resolve();
    await waitFor('fixture quantizations and owner profiles', () => evaluate(settingsWindow, () => {
      const quants = document.querySelector('[data-tutorial="featured-quantizations"]');
      return quants?.getAttribute('data-state') === 'ready' && quants.textContent.includes('Q4_K_M') &&
        document.querySelector('[data-tutorial="featured-provider"]')?.textContent.includes('Smoke Provider') &&
        document.querySelector('[data-tutorial="featured-uploader"]')?.textContent.includes('Smoke Uploader');
    }));
    await expectHighlight(settingsWindow, '[data-tutorial="featured-provider"]');
    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    await expectStep(settingsWindow, 'featured-models', 'featured-uploader', 'Meet the uploader');
    await expectHighlight(settingsWindow, '[data-tutorial="featured-uploader"]');
    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    await expectStep(settingsWindow, 'featured-models', 'featured-quantizations', 'Quantizations');
    await capture(settingsWindow, 'featured-quantizations', 1400);
    console.log('[tutorial-smoke] PASS settings handoff and independently delayed model metadata/files');

    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    await expectStep(settingsWindow, 'local-source', 'sources-navigation', 'Open Sources');
    await clickTarget(settingsWindow, '[data-tutorial="settings-sources-nav"]');
    await waitFor('Sources navigation rendered', () => evaluate(settingsWindow, () => !!document.querySelector('[data-tutorial="sources-add"]')));
    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    await expectStep(settingsWindow, 'local-source', 'sources-add', 'Add a source');
    const diskProviderCount = JSON.parse(fs.readFileSync(configFile, 'utf8')).llmProviders.length;
    await clickTarget(settingsWindow, '[data-tutorial="sources-add"]');
    let draftId = await waitFor('unsaved source draft', () => evaluate(settingsWindow, () => {
      const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
      return nav?.getAttribute('data-tutorial-settings-dirty') === 'true' &&
        nav.getAttribute('data-tutorial-source-state') === 'draft' ? nav.getAttribute('data-tutorial-source-id') : null;
    }));
    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    const beforeClose = await expectStep(settingsWindow, 'local-source', 'sources-model', 'Choose a local model');
    assert.equal(beforeClose.progress.sourceId, draftId, 'Draft identity was not retained for recovery');
    settingsWindow.destroy(); // Simulate an interruption without applying the draft.
    await waitFor('Settings closed with draft', async () => settingsWindow.isDestroyed());
    await waitFor('Home offers Settings recovery', async () => /continue in settings/i.test((await card(homeWindow))?.primary ?? ''));
    await clickPrimary(homeWindow, /^continue in settings$/i);
    settingsWindow = await waitWindow('settings');
    await waitFor('lost draft warning', async () => (await card(settingsWindow))?.title === 'Source draft unavailable');
    assert.equal((await snapshot(settingsWindow)).progress.active.stepId, 'sources-model');
    await clickPrimary(settingsWindow, /^return to add source$/i);
    await expectStep(settingsWindow, 'local-source', 'sources-add', 'Add a source');
    await clickTarget(settingsWindow, '[data-tutorial="sources-add"]');
    const oldDraftId = draftId;
    draftId = await waitFor('replacement source draft', () => evaluate(settingsWindow, (oldId) => {
      const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
      const id = nav?.getAttribute('data-tutorial-source-id');
      return nav?.getAttribute('data-tutorial-source-state') === 'draft' && id !== oldId ? id : null;
    }, oldDraftId));
    console.log('[tutorial-smoke] PASS lost source draft warning and explicit recovery');
    for (const [step, title] of [
      ['sources-model', 'Choose a local model'],
      ['sources-defaults', 'Model defaults'],
      ['sources-advanced', 'Advanced options'],
      ['sources-apply', 'Apply your changes'],
      ['celebration', 'You’re ready to explore'],
    ]) {
      await clickPrimary(settingsWindow, /^(next|continue anyway|continue without applying)$/i);
      await expectStep(settingsWindow, 'local-source', step, title);
      if (step === 'celebration') await capture(settingsWindow, 'celebration', 1800);
      if (step === 'sources-advanced') {
        await capture(settingsWindow, 'advanced-wiki', 1400);
        await clickTarget(settingsWindow, '.tutorial-wiki');
        await waitFor('wiki sent to the external-browser handler', async () => attempts.external.includes('https://github.com/ggml-org/llama.cpp/wiki'));
        assert.deepEqual(attempts.external, ['https://github.com/ggml-org/llama.cpp/wiki']);
        console.log('[tutorial-smoke] PASS external wiki handler (OS browser stubbed)');
      }
      const draft = await evaluate(settingsWindow, () => {
        const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
        return { id: nav?.getAttribute('data-tutorial-source-id'), dirty: nav?.getAttribute('data-tutorial-settings-dirty') };
      });
      assert.deepEqual(draft, { id: draftId, dirty: 'true' }, `Settings draft changed during ${step}`);
    }
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).llmProviders.length, diskProviderCount, 'Unapplied draft reached disk');
    console.log('[tutorial-smoke] PASS source draft preserved through tutorial transitions');

    await setMotion(settingsWindow, 'no-preference');
    const burst = await waitFor('celebration sparkle animation', () => evaluate(settingsWindow, () => {
      const node = document.querySelector('.tutorial-mascot__sparkles');
      const ring = document.querySelector('.tutorial-mascot__ring');
      if (!node || !ring) return null;
      const style = getComputedStyle(node);
      return { count: node.querySelectorAll('span').length, name: style.animationName,
        iterations: style.animationIterationCount, radius: getComputedStyle(ring).borderTopLeftRadius };
    }));
    assert.equal(burst.count, 5);
    assert.match(burst.name, /tutorial-mascot-celebrate/);
    assert.equal(burst.iterations, '1');
    assert.equal(burst.radius, '50%', 'Celebration rings must remain round despite the app-wide corner reset');
    await checkReducedMotion(settingsWindow, true);
    await clickPrimary(settingsWindow, /^finish$/i);
    const completed = await waitFor('completed tutorial on disk', async () => {
      const current = await snapshot(homeWindow);
      return current.progress.active === null && current.ownerId === null &&
        ['intro', 'local-engine', 'featured-models', 'local-source'].every((id) => current.progress.phases[id] === 'completed') ? current : null;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).tutorial, completed.progress);
    console.log('[tutorial-smoke] PASS celebration, reduced motion, and completed progress');

    // Close child windows only after verifying the draft; destroying the parent first
    // would implicitly close Settings while its captured parent is already destroyed.
    settingsWindow.destroy();
    if (!dependenciesWindow.isDestroyed()) dependenciesWindow.destroy();

    // Prove the download handoff with one explicitly clicked, completely synthetic install.
    rewriteProgress({
      revision: completed.progress.revision + 1,
      phases: { intro: 'completed' },
      active: { phaseId: 'local-engine', stepId: 'engine-install' },
    });
    homeWindow = await restartHome(homeWindow);
    await waitFor('resume engine setup from Home', async () => /continue in dependencies/i.test((await card(homeWindow))?.primary ?? ''));
    await clickPrimary(homeWindow, /^continue in dependencies$/i);
    dependenciesWindow = await waitWindow('dependencies');
    await expectStep(dependenciesWindow, 'local-engine', 'engine-install', 'Install if you want to');
    await waitFor('missing engine before synthetic install', () => evaluate(dependenciesWindow, () =>
      document.querySelector('[data-tutorial="dependencies-llama"]')?.getAttribute('data-tutorial-llama-state') === 'missing'));
    allowFakeLlamaInstall = true;
    await clickTarget(dependenciesWindow, '[data-tutorial="dependencies-llama-install"]');
    await waitFor('verified synthetic engine install', () => evaluate(dependenciesWindow, () => {
      const target = document.querySelector('[data-tutorial="dependencies-llama"]');
      return target?.getAttribute('data-tutorial-llama-state') === 'success' &&
        target.getAttribute('data-tutorial-dependencies-busy') === 'false';
    }));
    assert.equal(fakeLlamaInstalls, 1);
    await clickPrimary(dependenciesWindow, /^continue to home$/i);
    await expectStep(homeWindow, 'featured-models', 'home-model-manager', 'Explore models');
    await waitFor('idle Dependencies window closed after install', async () => dependenciesWindow.isDestroyed());
    console.log('[tutorial-smoke] PASS verified install handoff and Dependencies close (fixture only)');

    // Separately exercise a user-initiated Apply in the private config. No download occurs.
    rewriteProgress({
      revision: completed.progress.revision + 1,
      phases: { intro: 'completed', 'local-engine': 'completed', 'featured-models': 'completed' },
      active: { phaseId: 'local-source', stepId: 'sources-add' },
    });
    homeWindow = await restartHome(homeWindow);
    await waitFor('resume Sources from Home', async () => /continue in settings/i.test((await card(homeWindow))?.primary ?? ''));
    await clickPrimary(homeWindow, /^continue in settings$/i);
    settingsWindow = await waitWindow('settings');
    await expectStep(settingsWindow, 'local-source', 'sources-add', 'Add a source');
    await clickTarget(settingsWindow, '[data-tutorial="sources-add"]');
    const appliedId = await waitFor('draft before Apply', () => evaluate(settingsWindow, () => {
      const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
      return nav?.getAttribute('data-tutorial-source-state') === 'draft' ? nav.getAttribute('data-tutorial-source-id') : null;
    }));
    await delay(300); // Let the visible tutorial observe the draft before the user's Apply.
    allowSettingsSave = true;
    await clickTarget(settingsWindow, 'button[data-tutorial="settings-apply"]');
    await waitFor('user-applied source', () => evaluate(settingsWindow, (id) => {
      const nav = document.querySelector('[data-tutorial="settings-sources-nav"]');
      return nav?.getAttribute('data-tutorial-source-id') === id &&
        nav.getAttribute('data-tutorial-source-state') === 'persisted' &&
        nav.getAttribute('data-tutorial-settings-dirty') === 'false';
    }, appliedId));
    allowSettingsSave = false;
    assert.equal(approvedSettingsSaves, 1);
    assert.ok(JSON.parse(fs.readFileSync(configFile, 'utf8')).llmProviders.some((source) => source.id === appliedId));
    await clickPrimary(settingsWindow, /^(next|continue anyway)$/i);
    assert.equal((await expectStep(settingsWindow, 'local-source', 'sources-model', 'Choose a local model')).progress.sourceId, appliedId);
    settingsWindow.destroy();
    await waitFor('Home can reopen saved source', async () => /continue in settings/i.test((await card(homeWindow))?.primary ?? ''));
    await clickPrimary(homeWindow, /^continue in settings$/i);
    settingsWindow = await waitWindow('settings');
    await waitFor('saved source is available but unselected', async () => {
      const visible = await card(settingsWindow);
      return visible?.title === 'Choose a local model' && visible.text.includes('Select the source you created');
    });
    assert.notEqual((await card(settingsWindow)).title, 'Source draft unavailable');
    settingsWindow.destroy();
    console.log('[tutorial-smoke] PASS user-initiated Apply and saved-source recovery');

    // Exercise an active cursor surviving a renderer reload after the full tour. This
    // fixture setup happens only in the private temp config, never in the user's data.
    rewriteProgress({ revision: completed.progress.revision + 1, phases: {}, active: { phaseId: 'intro', stepId: 'home-start' } });
    homeWindow = await restartHome(homeWindow);
    const active = await expectStep(homeWindow, 'intro', 'home-start', 'Start here');
    let nativeReloadError = null;
    try {
      await reload(homeWindow);
    } catch (error) {
      nativeReloadError = error;
      console.error('[tutorial-smoke] Native reload failed; checking canonical index navigation:', String(error));
      // Keep the same WebContents/lease and verify tutorial recovery separately. Do not
      // hide the native reload failure: it is rethrown after this diagnostic check.
      await bounded(homeWindow.loadFile(path.join(dist, 'renderer/browser/index.html')), 12_000, 'canonical index navigation');
      await waitFor('Home shell after canonical navigation', () => evaluate(homeWindow, () => !!document.querySelector('app-shell .app-top-bar')));
    }
    const resumed = await expectStep(homeWindow, 'intro', 'home-start', 'Start here');
    assert.deepEqual(resumed.progress, active.progress, 'Navigation changed active tutorial progress');
    console.log(`[tutorial-smoke] PASS active cursor and lease across ${nativeReloadError ? 'canonical navigation' : 'reload'}`);
    if (nativeReloadError) throw nativeReloadError;

    const workspaceDir = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const restoredConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    restoredConfig.workspaces = [{ id: 'smoke-workspace', name: 'Smoke workspace', path: workspaceDir, createdAt: new Date().toISOString() }];
    restoredConfig.currentWorkspaceId = 'smoke-workspace';
    restoredConfig.defaultHomePageOnStart = false;
    restoredConfig.tutorial = { revision: resumed.progress.revision + 1, phases: {}, active: null };
    fs.writeFileSync(configFile, JSON.stringify(restoredConfig, null, 2), 'utf8');
    homeWindow = await restartHome(homeWindow);
    await waitFor('invitation after workspace restoration', async () => (await card(homeWindow))?.primary === 'Start tour');
    assert.equal(await evaluate(homeWindow, () => !!document.querySelector('[data-tutorial="home-start"]')), false);
    await clickPrimary(homeWindow, /^start tour$/i);
    await expectStep(homeWindow, 'intro', 'welcome', 'Welcome to Clara Coder');
    await clickPrimary(homeWindow, /^next$/i);
    await expectStep(homeWindow, 'intro', 'home-start', 'Start here');
    const afterTour = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(afterTour.currentWorkspaceId, 'smoke-workspace');
    assert.equal(afterTour.workspaces[0].path, workspaceDir);
    console.log('[tutorial-smoke] PASS restored workspace remains open while Home targets are absent');
  }

  async function finish(code, error) {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    depsGate.resolve();
    detailsGate.resolve();
    filesGate.resolve();
    if (error) console.error('[tutorial-smoke] FAIL', error instanceof Error ? error.stack : String(error));
    if (attempts.unsafeIpc.length || attempts.settingsSaves.length || attempts.subprocesses.length) {
      code = 1;
      console.error('[tutorial-smoke] Blocked unsafe actions:', JSON.stringify({
        ipc: attempts.unsafeIpc, settingsSaves: attempts.settingsSaves, subprocesses: attempts.subprocesses,
      }));
    }
    if (code && state) {
      for (const role of ['home', 'dependencies', 'settings']) {
        const win = windowFor(role);
        if (!win) continue;
        try {
          console.error(`[tutorial-smoke] ${role} diagnostic:`, JSON.stringify({ id: win.webContents.id, snapshot: await snapshot(win), card: await card(win) }));
        } catch (diagnosticError) {
          console.error(`[tutorial-smoke] ${role} diagnostic unavailable:`, String(diagnosticError));
        }
      }
    }
    try {
      const homeAtTeardown = state?.mainWindow;
      const windows = BrowserWindow.getAllWindows().sort((a, b) => Number(a === homeAtTeardown) - Number(b === homeAtTeardown));
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch {}
        win.destroy(); // Skip dirty Settings close prompts; never apply the draft.
      }
      await delay(250);
      if (state) {
        // Drain queued tutorial/config writes before removing their private directory.
        await bounded(require(path.join(dist, 'main/config/load-save.js')).loadConfig(), 2_000, 'flush config');
        require(path.join(dist, 'main/conversations-db.js')).closeConversationsDbForTests();
      }
      if (app.isReady()) {
        await bounded(Promise.allSettled([session.defaultSession.clearCache(), session.defaultSession.clearStorageData()]), 2_000, 'clear session');
      }
    } catch (cleanupError) {
      code = 1;
      console.error('[tutorial-smoke] Teardown error:', cleanupError);
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (cleanupError) {
      // On Windows Chromium can hold cache files until this process exits. The bounded,
      // detached helper removes only our mkdtemp directory after its parent has exited.
      try {
        const helper = `const fs=require('node:fs');const pid=Number(process.argv[1]);const dir=process.argv[2];let n=0;const t=setInterval(()=>{let alive=true;try{process.kill(pid,0)}catch{alive=false}if(!alive){clearInterval(t);try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:40,retryDelay:250})}catch{process.exitCode=1}}else if(++n>150){clearInterval(t);process.exitCode=1}},200);`;
        const child = spawnCleanup(process.execPath, ['-e', helper, String(process.pid), tempRoot], {
          detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.unref();
        console.log('[tutorial-smoke] Temp cleanup delegated until Electron releases its files');
      } catch (helperError) {
        code = 1;
        console.error(`[tutorial-smoke] Could not remove temp directory ${tempRoot}:`, cleanupError, helperError);
      }
    }
    console.log(`[tutorial-smoke] Safety: blocked dangerous IPC=${attempts.unsafeIpc.length}, unrequested Settings saves=${attempts.settingsSaves.length}, approved Settings saves=${approvedSettingsSaves}, synthetic installs=${fakeLlamaInstalls}, subprocesses=${attempts.subprocesses.length}, network attempts=${attempts.network.length}, external opens=${attempts.external.length}`);
    if (!code) console.log('[tutorial-smoke] TUTORIAL_SMOKE_OK (no real downloads; one synthetic install and one explicit Apply in isolated settings)');
    else console.error('[tutorial-smoke] TUTORIAL_SMOKE_FAILED; later checks may not have run');
    app.exit(code);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeDetails(id) {
  const owner = (name, fullname) => ({
    name, fullname, kind: 'org', avatarDataUrl: null, verified: false, numModels: null, numFollowers: null, details: '',
  });
  return {
    id, author: 'smoke-uploader', downloads: 0, likes: 0, createdAt: '', lastModified: '', license: '',
    baseModels: [], pipelineTag: '', architecture: '', parameterCount: null, contextLength: null,
    storageBytes: null, gated: false, private: false, tags: [],
    provider: owner('smoke-provider', 'Smoke Provider'), uploader: owner('smoke-uploader', 'Smoke Uploader'),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(win, fn, ...args) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('BrowserWindow was destroyed');
  const code = `(${fn.toString()})(...${JSON.stringify(args)})`;
  return bounded(win.webContents.executeJavaScript(code, true), 3_000, 'executeJavaScript');
}

async function waitFor(description, probe, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}${lastError ? `; last error: ${lastError.message ?? lastError}` : ''}`);
}
