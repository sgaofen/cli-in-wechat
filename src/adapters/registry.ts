import { log } from '../utils/logger.js';
import type { CLIAdapter } from './base.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { AiderAdapter } from './aider.js';
import { KimiAdapter } from './kimi.js';

export class AdapterRegistry {
  private adapters = new Map<string, CLIAdapter>();
  private available = new Set<string>();
  private byDisplayName = new Map<string, string>(); // displayName → name

  constructor() {
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
    this.register(new KimiAdapter());
    this.register(new AiderAdapter());
  }

  private register(adapter: CLIAdapter): void {
    this.adapters.set(adapter.name, adapter);
    this.byDisplayName.set(adapter.displayName, adapter.name);
  }

  getNameByDisplayName(displayName: string): string | undefined {
    return this.byDisplayName.get(displayName);
  }

  async detectAvailable(): Promise<void> {
    this.available.clear();

    const checks = Array.from(this.adapters.entries()).map(
      async ([name, adapter]) => {
        const ok = await adapter.isAvailable();
        if (ok) {
          this.available.add(name);
          log.info(`  [ok] ${adapter.displayName}`);
        } else {
          log.warn(`  [--] ${adapter.displayName} 未安装`);
        }
      },
    );

    await Promise.all(checks);
  }

  get(name: string): CLIAdapter | undefined {
    return this.adapters.get(name);
  }

  isAvailable(name: string): boolean {
    return this.available.has(name);
  }

  getAvailableNames(): string[] {
    return Array.from(this.available);
  }

  getAll(): CLIAdapter[] {
    return Array.from(this.adapters.values());
  }
}
