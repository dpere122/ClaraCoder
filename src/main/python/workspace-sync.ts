import type { AppConfig } from '../../shared';
import { PYTHON_URL } from './server';
import { getHostOsInfo } from '../utils/host-os';

/**
 * POST active LLM + audio config and host OS to Python so chat/transcribe use current settings.
 */
export async function syncRuntimeConfigToPython(config: AppConfig): Promise<void> {
  try {
    const response = await fetch(`${PYTHON_URL}/runtime-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeConnectionId: config.activeLlmConnectionId,
        connections: config.llmConnections,
        audio: config.audioTranscription,
        host: getHostOsInfo(),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Runtime config sync failed (${response.status}): ${detail}`);
    }
  } catch (err) {
    console.error('Failed to sync runtime config to Python:', err);
  }
}

/**
 * Pushes workspace tree text + human-readable watch summary into the Python agent context.
 */
export async function syncWorkspaceContextToPython(
  sessionId: string,
  workspacePath: string,
  workspaceContext: string,
  workspaceState: string,
): Promise<void> {
  await fetch(`${PYTHON_URL}/workspace-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      workspace_path: workspacePath,
      workspace_context: workspaceContext,
      workspace_state: workspaceState,
    }),
  });
}
