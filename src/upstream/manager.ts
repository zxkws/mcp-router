import type { McpServerConfig } from '../types.js';
import type { UpstreamClient } from './types.js';
import { HttpUpstreamClient } from './httpUpstream.js';
import { StdioUpstreamClient } from './stdioUpstream.js';
import type { Logger } from '../log.js';
import type { NormalizedRouterConfig } from '../config.js';

export class UpstreamManager {
  private readonly clients = new Map<string, UpstreamClient>();
  private readonly clientConfigs = new Map<string, string>();
  private readonly logger: Logger | null;
  private configRef: { current: NormalizedRouterConfig } | null;

  constructor(opts?: { logger?: Logger; configRef?: { current: NormalizedRouterConfig } }) {
    this.logger = opts?.logger ?? null;
    this.configRef = opts?.configRef ?? null;
  }

  setConfigRef(configRef: { current: NormalizedRouterConfig }) {
    this.configRef = configRef;
  }

  onConfigUpdate(newConfig: NormalizedRouterConfig) {
    for (const [name, client] of this.clients) {
      const newServerConfig = newConfig.mcpServers[name];
      if (!newServerConfig || !newServerConfig.enabled) {
        this.logger?.info('Upstream removed or disabled in config, closing connection', { name });
        void client.close();
        this.clients.delete(name);
        this.clientConfigs.delete(name);
        continue;
      }

      const newHash = JSON.stringify(newServerConfig);
      const oldHash = this.clientConfigs.get(name);
      if (newHash !== oldHash) {
        this.logger?.info('Upstream config changed, closing old connection', { name });
        void client.close();
        this.clients.delete(name);
        this.clientConfigs.delete(name);
      }
    }
  }

  getClient(name: string, cfg: McpServerConfig): UpstreamClient {
    const existing = this.clients.get(name);
    if (existing) return existing;

    let created: UpstreamClient;
    if (cfg.transport === 'stdio') {
      created = new StdioUpstreamClient(name, cfg, {
        logger: this.logger,
        sandbox: this.configRef?.current.sandbox.stdio ?? null,
      });
    } else if (cfg.transport === 'streamable-http' || cfg.transport === 'http') {
      created = new HttpUpstreamClient(name, cfg, { logger: this.logger });
    } else {
      const _exhaustive: never = cfg.transport;
      throw new Error(`Unsupported upstream transport: ${_exhaustive}`);
    }

    this.clients.set(name, created);
    this.clientConfigs.set(name, JSON.stringify(cfg));
    return created;
  }

  async closeAll() {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    this.clientConfigs.clear();
  }
}
