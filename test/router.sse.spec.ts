import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
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

test('deprecated sse: can call router tools via /sse + /messages', async () => {
  const base = new URL(router.url);
  const sseUrl = new URL('/sse', `${base.protocol}//${base.host}`);

  const client = new Client({ name: 'sse-test-client', version: '1.0.0' });
  const transport = new SSEClientTransport(sseUrl, {
    requestInit: { headers: { Authorization: 'Bearer dev-token' } },
    eventSourceInit: {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', 'Bearer dev-token');
        return fetch(url, { ...init, headers });
      },
    },
  });

  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providersJson = providers.structuredContent as any;
  expect(providersJson.providers.map((p: any) => p.name)).toContain('demo');

  const call = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'demo', name: 'echo', arguments: { message: 'hello-sse' } },
  });
  const callJson = call.structuredContent as any;
  expect(callJson.structuredContent.message).toBe('hello-sse');

  await client.close();
});
