import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import { startHttpServer } from '../src/httpServer.js';
import { UpstreamManager } from '../src/upstream/httpUpstream.js';
import { createLogger } from '../src/log.js';
import type { NormalizedRouterConfig } from '../src/config.js';

let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let router: Awaited<ReturnType<typeof startHttpServer>>;
const upstreams = new UpstreamManager();

beforeAll(async () => {
  upstream = await startMockUpstream();
  const config: NormalizedRouterConfig = {
    configPath: '<in-memory>',
    listen: { http: { host: '127.0.0.1', port: 0, path: '/mcp' }, stdio: true },
    auth: { tokens: [{ value: 'dev-token', allowedMcpServers: null }] },
    mcpServers: {
      demo: { transport: 'streamable-http', url: upstream.url, enabled: true },
    },
  };
  router = await startHttpServer({
    configRef: { current: config },
    upstreams,
    logger: createLogger(),
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
  });
});

afterAll(async () => {
  await router.close();
  await upstream.close();
});

test('http mode: list_providers/tools.list/tools.call work with auth', async () => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
  });

  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providersJson = providers.structuredContent as any;
  expect(providersJson.providers.map((p: any) => p.name)).toContain('demo');

  const tools = await client.callTool({ name: 'tools.list', arguments: { provider: 'demo' } });
  const toolsJson = tools.structuredContent as any;
  expect(toolsJson.tools.map((t: any) => t.name)).toContain('echo');

  const call = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'demo', name: 'echo', arguments: { message: 'hello' } },
  });
  const callJson = call.structuredContent as any;
  expect(callJson.structuredContent.message).toBe('hello');

  await client.close();
});
