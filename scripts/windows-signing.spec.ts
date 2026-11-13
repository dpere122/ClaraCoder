import { describe, expect, it } from 'vitest';

import {
  AZURE_CREDENTIAL_VARS,
  AZURE_SIGNING,
  REQUIRE_SIGNING_VAR,
  assertSigned,
  azureSigningArgs,
  signatureProblem,
} from './windows-signing.mjs';

const CREDENTIALS = { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' };
const SIGNED = { status: 'Valid', subject: 'CN=Daniel Perez, O=Daniel Perez, L=Springfield, S=fl, C=US' };

describe('azureSigningArgs', () => {
  it('leaves a build without credentials unsigned', () => {
    expect(azureSigningArgs({}, 'win32')).toEqual([]);
    expect(azureSigningArgs({ AZURE_CLIENT_SECRET: '  ' }, 'win32')).toEqual([]);
  });

  it('passes the signing identity when the credentials are set', () => {
    const args = azureSigningArgs(CREDENTIALS, 'win32');
    expect(args).toEqual([
      '--config.win.azureSignOptions.publisherName=Daniel Perez',
      '--config.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net/',
      '--config.win.azureSignOptions.codeSigningAccountName=ClaraCoder',
      '--config.win.azureSignOptions.certificateProfileName=claracoder-public',
    ]);
    // The credentials stay in the environment: electron-builder's signer reads them there.
    expect(args.join(' ')).not.toMatch(/tenant|client|secret/);
    expect(Object.keys(AZURE_SIGNING)).toHaveLength(args.length);
  });

  it('signs Windows builds only', () => {
    expect(azureSigningArgs(CREDENTIALS, 'darwin')).toEqual([]);
    expect(azureSigningArgs({ [REQUIRE_SIGNING_VAR]: '1' }, 'linux')).toEqual([]);
  });

  it('refuses a half-configured build', () => {
    for (const name of AZURE_CREDENTIAL_VARS) {
      const env = { ...CREDENTIALS, [name]: '' };
      expect(() => azureSigningArgs(env, 'win32')).toThrow(name);
    }
  });

  it('refuses an unsigned build when a release requires signing', () => {
    expect(() => azureSigningArgs({ [REQUIRE_SIGNING_VAR]: '1' }, 'win32')).toThrow(/unsigned release/);
    expect(azureSigningArgs({ ...CREDENTIALS, [REQUIRE_SIGNING_VAR]: '1' }, 'win32')).toHaveLength(4);
  });
});

describe('signature check', () => {
  it('accepts a valid signature from the publisher', () => {
    expect(signatureProblem(SIGNED)).toBeNull();
  });

  it('names what is wrong with any other file', () => {
    expect(signatureProblem({ status: 'NotSigned', subject: null })).toMatch(/NotSigned/);
    expect(signatureProblem({ status: 'HashMismatch', subject: SIGNED.subject })).toMatch(/HashMismatch/);
    expect(signatureProblem({ status: 'Valid', subject: 'CN=Someone Else, O=Someone Else, C=US' })).toMatch(/Someone Else/);
    // A longer name that only starts the same is another publisher.
    expect(signatureProblem({ status: 'Valid', subject: 'CN=Daniel Perezoso, C=US' })).toMatch(/not Daniel Perez/);
  });

  it('checks every file and reports each failure', () => {
    const read = (file: string) => (file === 'app.exe' ? SIGNED : { status: 'NotSigned', subject: null });
    expect(() => assertSigned(['app.exe'], AZURE_SIGNING.publisherName, read)).not.toThrow();
    expect(() => assertSigned(['app.exe', 'setup.exe', 'other.exe'], AZURE_SIGNING.publisherName, read)).toThrow(
      /setup\.exe: signature is NotSigned\n\s+other\.exe/,
    );
    // Signing was on, so "nothing to check" is a failure too.
    expect(() => assertSigned([], AZURE_SIGNING.publisherName, read)).toThrow(/no file to check/);
  });
});
