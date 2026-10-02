import { Component, OnDestroy, OnInit, ViewEncapsulation, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { unwrapSecret, type McpServerConfig } from '@shared/index';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-mcp',
  imports: [FormsModule],
  templateUrl: './settings-mcp.html',
  styleUrl: './settings-mcp.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsMcp implements OnInit, OnDestroy {
  protected readonly s = inject(SettingsStore);
  protected readonly unwrapSecret = unwrapSecret;
  protected readonly expanded = signal<Record<string, boolean>>({});
  protected readonly signInError = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.s.refreshMcpStatus();
    this.timer = setInterval(() => void this.s.refreshMcpStatus(), 2000);
  }

  ngOnDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  protected argsText(server: McpServerConfig): string {
    return (server.args ?? []).join('\n');
  }

  protected setTransport(server: McpServerConfig, value: string): void {
    this.s.patchMcpServer(server.id, { transport: value === 'http' ? 'http' : 'stdio' });
  }

  protected setHttpTransport(server: McpServerConfig, value: string): void {
    this.s.patchMcpServer(server.id, { httpTransport: value === 'sse' ? 'sse' : 'streamable' });
  }

  protected setHttpAuth(server: McpServerConfig, value: string): void {
    const httpAuth = value === 'headers' || value === 'oauth' ? value : 'none';
    this.s.patchMcpServer(server.id, { httpAuth });
  }

  protected setToolDecision(serverId: string, toolName: string, value: string): void {
    const decision = value === 'allow' || value === 'deny' ? value : 'ask';
    this.s.setMcpToolDecision(serverId, toolName, decision);
  }

  protected setArgs(server: McpServerConfig, text: string): void {
    const args = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    this.s.patchMcpServer(server.id, { args });
  }

  protected toggleExpanded(id: string): void {
    this.expanded.update((current) => ({ ...current, [id]: !current[id] }));
  }

  protected isExpanded(id: string): boolean {
    return !!this.expanded()[id];
  }

  protected async signIn(id: string): Promise<void> {
    this.signInError.set('');
    const error = await this.s.signInMcp(id);
    this.signInError.set(error);
  }

  protected signedIn(server: McpServerConfig): boolean {
    return !!unwrapSecret(server.oauth?.accessToken).trim();
  }
}
