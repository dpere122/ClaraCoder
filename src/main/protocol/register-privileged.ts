import { protocol } from 'electron';

/**
 * Must run before `app.ready` so renderer can use `nemo-tts://` with stream + fetch privileges.
 */
export function registerPrivilegedNemoTtsScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'nemo-tts',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}
