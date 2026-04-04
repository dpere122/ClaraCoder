/** How to spawn a one-off script (temp file + shell invocation). */
export interface ScriptLaunchPlan {
  shellCmd: string;
  shellArgs: string[];
  tempFile: string;
}
