import path = require('path');
const syncFs = require('fs');
import type { ScriptLaunchPlan } from '../../shared';

/**
 * Resolves Git Bash or `NEMO_BASH_PATH` so `.sh` scripts can run on Windows.
 */
export function getWindowsBashPath(): string | null {
  const configured = process.env.NEMO_BASH_PATH?.trim();
  const candidates = [
    configured,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    if (syncFs.existsSync(candidate)) {
      return candidate;
    }
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const bashExe = path.join(entry, 'bash.exe');
    if (syncFs.existsSync(bashExe)) {
      return bashExe;
    }
  }

  return null;
}

/**
 * Writes the script to a temp file and returns the shell command to execute it.
 */
export async function buildScriptLaunchPlan(language: string, script: string): Promise<ScriptLaunchPlan> {
  const langLower = language.toLowerCase();
  const { writeFile } = require('fs').promises;
  const os = require('os');

  if (langLower.includes('batch') || langLower.includes('bat') || langLower.includes('cmd')) {
    const tempFile = path.join(os.tmpdir(), `nemo-script-${Date.now()}.bat`);
    await writeFile(tempFile, script, 'utf8');
    return { shellCmd: 'cmd.exe', shellArgs: ['/c', tempFile], tempFile };
  }

  if (langLower.includes('powershell') || langLower.includes('ps1')) {
    const tempFile = path.join(os.tmpdir(), `nemo-script-${Date.now()}.ps1`);
    const bom = '\ufeff';
    await writeFile(tempFile, bom + script, 'utf8');
    return {
      shellCmd: 'powershell.exe',
      shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
      tempFile,
    };
  }

  if (langLower === 'bash' || langLower === 'sh' || langLower === 'shell') {
    const tempFile = path.join(os.tmpdir(), `nemo-script-${Date.now()}.sh`);
    await writeFile(tempFile, script, 'utf8');

    if (process.platform === 'win32') {
      const bashPath = getWindowsBashPath();
      if (!bashPath) {
        throw new Error(
          'No Bash-compatible shell was found on Windows. Install Git Bash or set NEMO_BASH_PATH, or ask for a PowerShell script on Windows.',
        );
      }
      return { shellCmd: bashPath, shellArgs: [tempFile], tempFile };
    }

    const shellCmd = langLower === 'bash' ? '/bin/bash' : '/bin/sh';
    return { shellCmd, shellArgs: [tempFile], tempFile };
  }

  const tempFile = path.join(os.tmpdir(), `nemo-script-${Date.now()}.ps1`);
  const bom = '\ufeff';
  await writeFile(tempFile, bom + script, 'utf8');
  return {
    shellCmd: 'powershell.exe',
    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
    tempFile,
  };
}
