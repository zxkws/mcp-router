import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { performance } from 'node:perf_hooks';
import type { NormalizedRouterConfig } from './config.js';
import { assertAllowedMcpServer } from './auth.js';
import type { AuthedPrincipal } from './types.js';
import type { Logger } from './log.js';
import { UpstreamManager } from './upstream/httpUpstream.js';

export type RouterRuntime = {
  configRef: { current: NormalizedRouterConfig };
  principal: AuthedPrincipal;
  upstreams: UpstreamManager;
  logger: Logger;
  metrics?: {
    observeToolCall: (labels: { server: string; tool: string; ok: boolean }, seconds: number) => void;
  };
};

function enabledServers(cfg: NormalizedRouterConfig, principal: AuthedPrincipal) {
  const entries = Object.entries(cfg.mcpServers).filter(([, v]) => v.enabled);
  if (!principal.enabled || !principal.allowedMcpServers) return entries;
  return entries.filter(([name]) => principal.allowedMcpServers!.has(name));
}

export function createRouterMcpServer(runtime: RouterRuntime) {
  const server = new McpServer({ name: 'mcp-router', version: '0.1.0' });

  server.registerTool(
    'list_providers',
    {
      title: 'List Providers',
      description: 'List configured upstream MCP servers (providers).',
      inputSchema: {},
      outputSchema: {
        providers: z.array(
          z.object({
            name: z.string(),
            url: z.string(),
            transport: z.string(),
            tags: z.array(z.string()).optional(),
            version: z.string().optional(),
          }),
        ),
      },
    },
    async () => {
      const cfg = runtime.configRef.current;
      const providers = enabledServers(cfg, runtime.principal).map(([name, s]) => ({
        name,
        url: s.url,
        transport: s.transport,
        tags: s.tags,
        version: s.version,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ providers }, null, 2) }],
        structuredContent: { providers },
      };
    },
  );

  server.registerTool(
    'tools.list',
    {
      title: 'List Tools (by provider)',
      description: 'List tools for a given provider (upstream MCP server).',
      inputSchema: { provider: z.string() },
      outputSchema: {
        provider: z.string(),
        tools: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.any().optional(),
          }),
        ),
      },
    },
    async ({ provider }) => {
      const cfg = runtime.configRef.current;
      assertAllowedMcpServer(runtime.principal, provider);
      const upstream = cfg.mcpServers[provider];
      if (!upstream || !upstream.enabled) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      if (upstream.transport !== 'streamable-http' && upstream.transport !== 'http') {
        throw new Error(`Unsupported upstream transport in MVP: ${upstream.transport}`);
      }
      const client = runtime.upstreams.getHttpClient(provider, upstream);
      const tools = await client.listTools();
      return {
        content: [{ type: 'text', text: JSON.stringify({ provider, tools: tools.tools }, null, 2) }],
        structuredContent: { provider, tools: tools.tools },
      };
    },
  );

  server.registerTool(
    'tools.call',
    {
      title: 'Call Tool (by provider)',
      description: 'Call a tool on a given provider (upstream MCP server).',
      inputSchema: {
        provider: z.string(),
        name: z.string().describe('Upstream tool name'),
        arguments: z.unknown().optional(),
      },
      outputSchema: {
        provider: z.string(),
        name: z.string(),
        content: z.any(),
        structuredContent: z.any().optional(),
      },
    },
    async ({ provider, name, arguments: args }) => {
      const start = performance.now();
      let ok = false;
      try {
        const cfg = runtime.configRef.current;
        assertAllowedMcpServer(runtime.principal, provider);
        const upstream = cfg.mcpServers[provider];
        if (!upstream || !upstream.enabled) {
          throw new Error(`Unknown provider: ${provider}`);
        }
        if (upstream.transport !== 'streamable-http' && upstream.transport !== 'http') {
          throw new Error(`Unsupported upstream transport in MVP: ${upstream.transport}`);
        }
        const client = runtime.upstreams.getHttpClient(provider, upstream);
        const result = await client.callTool({ name, arguments: args ?? {} });
        ok = true;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { provider, name, content: result.content, structuredContent: result.structuredContent },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            provider,
            name,
            content: result.content,
            structuredContent: result.structuredContent,
          },
        };
      } finally {
        const seconds = (performance.now() - start) / 1000;
        runtime.metrics?.observeToolCall({ server: provider, tool: name, ok }, seconds);
      }
    },
  );

  return server;
}
