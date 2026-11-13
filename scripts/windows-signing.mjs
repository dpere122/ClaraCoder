/**
 * Windows code signing through Azure Artifact Signing (electron-builder's `win.azureSignOptions`).
 *
 * The identity below is public: it is on every signed installer. The credentials are not. They are
 * three environment variables of a Microsoft Entra app registration that holds the "Certificate
 * Profile Signer" role on the signing account, and the release workflow passes them from repository
 * secrets. With none of them set (a local `npm run pack`, a fork) the build is unsigned, as before.
 *
 * A signed build is checked afterwards: electron-builder reports success for a file it skipped.
 */
import { execFileSync } from 'child_process';

/** The Artifact Signing account, its Public Trust profile, and the name on the certificate. */
export const AZURE_SIGNING = {
  publisherName: 'Daniel Perez',
  // Must be the region the account was created in (East US).
  endpoint: 'https://eus.codesigning.azure.net/',
  codeSigningAccountName: 'ClaraCoder',
  certificateProfileName: 'claracoder-public',
};

export const AZURE_CREDENTIAL_VARS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

/** Set by the release workflow: a release must not go out unsigned because a secret went missing. */
export const REQUIRE_SIGNING_VAR = 'CLARA_REQUIRE_SIGNING';

/**
 * electron-builder arguments that turn signing on, or none when this build is unsigned.
 * Throws when only some credentials are set, or when signing is required and none are.
 */
export function azureSigningArgs(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return [];
  const missing = AZURE_CREDENTIAL_VARS.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length === AZURE_CREDENTIAL_VARS.length) {
    if (String(env[REQUIRE_SIGNING_VAR] ?? '').trim()) {
      throw new Error(`${REQUIRE_SIGNING_VAR} is set but ${missing.join(', ')} are not: refusing to build an unsigned release.`);
    }
    return [];
  }
  if (missing.length) {
    throw new Error(`Windows signing needs ${missing.join(', ')} as well.`);
  }
  return Object.entries(AZURE_SIGNING).map(([key, value]) => `--config.win.azureSignOptions.${key}=${value}`);
}

/** What is wrong with a file's signature (`{status, subject}` from Get-AuthenticodeSignature), or null. */
export function signatureProblem(info, publisher = AZURE_SIGNING.publisherName) {
  if (info.status !== 'Valid') return `signature is ${info.status}`;
  if (!String(info.subject ?? '').startsWith(`CN=${publisher},`)) return `signed by "${info.subject}", not ${publisher}`;
  return null;
}

/** Reads a file's Authenticode signature via PowerShell (path passed in env, never interpolated). */
export function readAuthenticode(file) {
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:CLARA_SIG_PATH; ' +
    '[pscustomobject]@{ status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }) } | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, CLARA_SIG_PATH: file },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const parsed = JSON.parse(out.trim());
  return {
    status: typeof parsed.status === 'string' ? parsed.status : 'Unknown',
    subject: typeof parsed.subject === 'string' ? parsed.subject : null,
  };
}

/** Throws unless every file carries a valid signature from the publisher. */
export function assertSigned(files, publisher = AZURE_SIGNING.publisherName, read = readAuthenticode) {
  if (!files.length) throw new Error('Signing was on but there is no file to check.');
  const problems = [];
  for (const file of files) {
    const problem = signatureProblem(read(file), publisher);
    if (problem) problems.push(`${file}: ${problem}`);
  }
  if (problems.length) throw new Error(`Windows signing check failed:\n  ${problems.join('\n  ')}`);
}
