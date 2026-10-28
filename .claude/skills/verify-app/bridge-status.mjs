#!/usr/bin/env node
/**
 * Prints the dev browser bridge state as JSON: whether the app is up and the URL to open for
 * each window. `--wait <seconds>` polls until a live app has written its bridge file.
 *
 *   node .claude/skills/verify-app/bridge-status.mjs --wait 90
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const BRIDGE_FILE = join(process.env.APPDATA ?? '', 'clara-coder-dev', 'browser-bridge.json');
const waitArg = process.argv.indexOf('--wait');
const waitSeconds = waitArg >= 0 ? Number(process.argv[waitArg + 1] ?? 60) : 0;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function read() {
  try {
    const info = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'));
    return { up: typeof info.pid === 'number' && isAlive(info.pid), ...info };
  } catch {
    return { up: false };
  }
}

const deadline = Date.now() + waitSeconds * 1000;
let state = read();
while (!state.up && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  state = read();
}

const { up, pid, windows, url } = state;
console.log(JSON.stringify(up ? { up, pid, windows: windows ?? { main: url } } : { up, file: BRIDGE_FILE }, null, 2));
process.exitCode = up ? 0 : 1;
