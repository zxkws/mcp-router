import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import { startHttpServer } from '../src/httpServer.js';
import { UpstreamManager } from '../src/upstream/manager.js';
import { createLogger } from '../src/log.js';
import type { NormalizedRouterConfig } from '../src/config.js';

let upstreamA: Awaited<ReturnType<typeof startMockUpstream>>;
let upstreamB: Awaited<ReturnType<typeof startMockUpstream>>;
let router: Awaited<ReturnType<typeof startHttpServer>>;
const upstreams = new UpstreamManager();

beforeAll(async () => {
  upstreamA = await startMockUpstream('A');
  upstreamB = await startMockUpstream('B');

  const config: NormalizedRouterConfig = {
    configPath: '<in-memory>',
    listen: { http: { host: '127.0.0.1', port: 0, path: '/mcp' }, stdio: true },
    admin: { enabled: false, path: '/admin', allowUnauthenticated: false },
    toolExposure: 'hierarchical',
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
      demoA: { transport: 'streamable-http', url: upstreamA.url, enabled: true, tags: ['demo'] },
      demoB: { transport: 'streamable-http', url: upstreamB.url, enabled: true, tags: ['demo'] },
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
  await upstreamA.close();
  await upstreamB.close();
});

test('tag routing: provider=tag:<tag> round-robins among matching upstreams', async () => {
  const client = new Client({ name: 'tag-routing-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
  });
  await client.connect(transport);

  const r1 = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo', name: 'echo', arguments: { message: 'x' } },
  });
  const r1j = r1.structuredContent as any;
  expect(r1j.structuredContent.upstream).toBe('A');

  const r2 = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo', name: 'echo', arguments: { message: 'y' } },
  });
  const r2j = r2.structuredContent as any;
  expect(r2j.structuredContent.upstream).toBe('B');

  await client.close();
});
