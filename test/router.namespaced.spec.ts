import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import { startHttpServer } from '../src/httpServer.js';
import { UpstreamManager } from '../src/upstream/manager.js';
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
    admin: { enabled: false, path: '/admin', allowUnauthenticated: false },
    toolExposure: 'both',
    routing: {
      selectorStrategy: 'roundRobin',
      healthChecks: { enabled: false, intervalMs: 15_000, timeoutMs: 5_000, includeStdio: false },
      circuitBreaker: { enabled: true, failureThreshold: 3, openMs: 30_000 },
    },
    audit: { enabled: true, logArguments: false, maxArgumentChars: 2000 },
    projects: {},
    sandbox: { stdio: { allowedCommands: null, allowedCwdRoots: null, allowedEnvKeys: null, inheritEnvKeys: null } },
    auth: {
      tokens: [
        {
          value: 'dev-token',
          projectId: null,
          allowedMcpServers: null,
          allowedTags: null,
          rateLimitRpm: null,
        },
      ],
    },
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

test('namespaced tools: exposes demo.echo and forwards calls', async () => {
  const client = new Client({ name: 'namespaced-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
  });
  await client.connect(transport);

  const listed = await client.listTools();
  expect(listed.tools.some((t: any) => t.name === 'demo.echo')).toBe(true);

  const res = await client.callTool({ name: 'demo.echo', arguments: { message: 'hi' } });
  expect((res.structuredContent as any).message).toBe('hi');

  await client.close();
});
