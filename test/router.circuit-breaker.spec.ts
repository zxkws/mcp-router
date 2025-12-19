import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import { startHttpServer } from '../src/httpServer.js';
import { UpstreamManager } from '../src/upstream/manager.js';
import { createLogger } from '../src/log.js';
import type { NormalizedRouterConfig } from '../src/config.js';

let bad: Awaited<ReturnType<typeof startMockUpstream>>;
let good: Awaited<ReturnType<typeof startMockUpstream>>;
let router: Awaited<ReturnType<typeof startHttpServer>>;
const upstreams = new UpstreamManager();

beforeAll(async () => {
  bad = await startMockUpstream('bad', { failRequestsAfterInit: true });
  good = await startMockUpstream('good');

  const config: NormalizedRouterConfig = {
    configPath: '<in-memory>',
    listen: { http: { host: '127.0.0.1', port: 0, path: '/mcp' }, stdio: true },
    admin: { enabled: false, path: '/admin', allowUnauthenticated: false },
    toolExposure: 'hierarchical',
    routing: {
      selectorStrategy: 'roundRobin',
      healthChecks: { enabled: false, intervalMs: 15_000, timeoutMs: 5_000, includeStdio: false },
      circuitBreaker: { enabled: true, failureThreshold: 1, openMs: 60_000 },
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
      demoA: { transport: 'streamable-http', url: bad.url, enabled: true, tags: ['demo'] },
      demoB: { transport: 'streamable-http', url: good.url, enabled: true, tags: ['demo'] },
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
  await bad.close();
  await good.close();
});

test('circuit breaker: failing upstream is skipped for tag selectors after opening', async () => {
  const client = new Client({ name: 'circuit-breaker-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
  });
  await client.connect(transport);

  let failed = false;
  try {
    await client.callTool({
      name: 'tools.call',
      arguments: { provider: 'tag:demo', name: 'echo', arguments: { message: 'x' } },
    });
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);

  const ok = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'tag:demo', name: 'echo', arguments: { message: 'y' } },
  });
  expect((ok.structuredContent as any).structuredContent.upstream).toBe('good');

  await client.close();
});
