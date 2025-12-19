import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../types.js';
import type { UpstreamClient } from './types.js';
import type { Logger } from '../log.js';

export class HttpUpstreamClient implements UpstreamClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly cfg: McpServerConfig;
  private readonly name: string;
  private readonly logger: Logger | null;

  constructor(name: string, cfg: McpServerConfig, opts?: { logger?: Logger | null }) {
    this.name = name;
    this.cfg = cfg;
    this.logger = opts?.logger ?? null;
  }

  private async connectIfNeeded() {
    if (this.connectPromise) return this.connectPromise;
    if (this.client) return;

    this.connectPromise = (async () => {
      const client = new Client({ name: `mcp-router-upstream:${this.name}`, version: '0.1.0' });
      if (!this.cfg.url) {
        throw new Error(`Upstream ${this.name} is missing url`);
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
        requestInit: { headers: this.cfg.headers },
      });
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.logger?.info('upstream http connected', { upstream: this.name, url: this.cfg.url });
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async listTools() {
    await this.connectIfNeeded();
    const timeout = this.cfg.timeoutMs;
    return this.client!.listTools(undefined, timeout ? { timeout } : undefined);
  }

  async callTool(input: { name: string; arguments: unknown }) {
    await this.connectIfNeeded();
    const timeout = this.cfg.timeoutMs;
    return this.client!.callTool(
      { name: input.name, arguments: input.arguments as any },
      undefined,
      timeout ? { timeout } : undefined,
    );
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.transport = null;
      this.connectPromise = null;
    }
  }
}

// (manager moved to ./manager.ts)
