import { log } from '../utils/logger.js';
import type { CLIAdapter } from './base.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { KimiAdapter } from './kimi.js';
import { OpenCodeAdapter } from './opencode-sdk.js';
import { OpenCodeAdapter as OpenCodeCliAdapter } from './opencode.js';

export class AdapterRegistry {
  private adapters = new Map<string, CLIAdapter>();
  private available = new Set<string>();
  private byDisplayName = new Map<string, string>(); // displayName → name
  // Fallback chains: primary name → [fallback names]
  private fallbackChains = new Map<string, string[]>();

  constructor() {
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
    this.register(new KimiAdapter());
    // Register SDK adapter as primary, CLI adapter as fallback
    this.register(new OpenCodeAdapter());
    this.register(new OpenCodeCliAdapter(), 'opencode-cli');
    this.fallbackChains.set('opencode', ['opencode-cli']);
  }

  private register(adapter: CLIAdapter, fallbackName?: string): void {
    const name = fallbackName || adapter.name;
    this.adapters.set(name, adapter);
    // Only set displayName mapping if not already set (primary takes priority)
    if (!this.byDisplayName.has(adapter.displayName)) {
      this.byDisplayName.set(adapter.displayName, name);
    }
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
    if (this.available.has(name)) {
      return this.adapters.get(name);
    }
    // Check fallback chain
    const chain = this.fallbackChains.get(name);
    if (chain) {
      for (const fallback of chain) {
        if (this.available.has(fallback)) {
          log.info(`[${name}] SDK 不可用，回退到 CLI 模式`);
          return this.adapters.get(fallback);
        }
      }
    }
    return this.adapters.get(name);
  }

  isAvailable(name: string): boolean {
    if (this.available.has(name)) return true;
    // Check if any fallback in the chain is available
    const chain = this.fallbackChains.get(name);
    if (chain) {
      return chain.some(fallback => this.available.has(fallback));
    }
    return false;
  }

  getAvailableNames(): string[] {
    const names = new Set<string>();
    for (const name of this.available) {
      names.add(name);
    }
    // Also add primary names whose fallback is available
    for (const [primary, chain] of this.fallbackChains) {
      if (!this.available.has(primary) && chain.some(f => this.available.has(f))) {
        names.add(primary);
      }
    }
    return Array.from(names);
  }

  getAll(): CLIAdapter[] {
    return Array.from(this.adapters.values());
  }
}
