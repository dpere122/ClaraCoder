import { protocol } from 'electron';

/**
 * Must run before `app.ready`. `registerSchemesAsPrivileged` may only be called once,
 * so every privileged scheme (TTS audio streaming, workspace image assets) registers here.
 */
export function registerPrivilegedSchemes(): void {
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
    {
      scheme: 'nemo-asset',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
      },
    },
  ]);
}
