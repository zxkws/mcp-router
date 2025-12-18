import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../types.js';

export class HttpUpstreamClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private readonly cfg: McpServerConfig;
  private readonly name: string;

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  private async connectIfNeeded() {
    if (this.client) return;
    this.client = new Client({ name: `mcp-router-upstream:${this.name}`, version: '0.1.0' });
    this.transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
      requestInit: { headers: this.cfg.headers },
    });
    await this.client.connect(this.transport);
  }

  async listTools() {
    await this.connectIfNeeded();
    return this.client!.listTools();
  }

  async callTool(input: { name: string; arguments: unknown }) {
    await this.connectIfNeeded();
    return this.client!.callTool({ name: input.name, arguments: input.arguments as any });
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.transport = null;
    }
  }
}

export class UpstreamManager {
  private readonly clients = new Map<string, HttpUpstreamClient>();

  getHttpClient(name: string, cfg: McpServerConfig): HttpUpstreamClient {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const created = new HttpUpstreamClient(name, cfg);
    this.clients.set(name, created);
    return created;
  }

  async closeAll() {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
