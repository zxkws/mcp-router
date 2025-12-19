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
      demoA: { transport: 'streamable-http', url: upstreamA.url, enabled: true, tags: ['demo'], version: '1.0.0' },
      demoB: { transport: 'streamable-http', url: upstreamB.url, enabled: true, tags: ['demo'], version: '1.1.0' },
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

test('version routing: provider selectors can filter by semver range', async () => {
  const client = new Client({ name: 'version-routing-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
  });
  await client.connect(transport);

  const exact = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo@1.0.0', name: 'echo', arguments: { message: 'x' } },
  });
  expect((exact.structuredContent as any).structuredContent.upstream).toBe('A');

  const byVersion = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'version:1.1.0', name: 'echo', arguments: { message: 'y' } },
  });
  expect((byVersion.structuredContent as any).structuredContent.upstream).toBe('B');

  const r1 = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo@^1.0.0', name: 'echo', arguments: { message: 'm1' } },
  });
  expect((r1.structuredContent as any).structuredContent.upstream).toBe('A');

  const r2 = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo@^1.0.0', name: 'echo', arguments: { message: 'm2' } },
  });
  expect((r2.structuredContent as any).structuredContent.upstream).toBe('B');

  await client.close();
});
