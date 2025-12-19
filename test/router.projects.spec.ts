import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import { startHttpServer } from '../src/httpServer.js';
import { UpstreamManager } from '../src/upstream/manager.js';
import { createLogger } from '../src/log.js';
import type { NormalizedRouterConfig } from '../src/config.js';

let upstream1: Awaited<ReturnType<typeof startMockUpstream>>;
let upstream2: Awaited<ReturnType<typeof startMockUpstream>>;
let router: Awaited<ReturnType<typeof startHttpServer>>;
const upstreams = new UpstreamManager();

beforeAll(async () => {
  upstream1 = await startMockUpstream();
  upstream2 = await startMockUpstream();

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
    projects: {
      p1: {
        id: 'p1',
        name: 'Project 1',
        allowedMcpServers: ['demo1'],
        allowedTags: null,
        rateLimitRpm: null,
      },
    },
    sandbox: { stdio: { allowedCommands: null, allowedCwdRoots: null, allowedEnvKeys: null, inheritEnvKeys: null } },
    auth: {
      tokens: [
        {
          value: 'token-p1',
          projectId: 'p1',
          allowedMcpServers: null,
          allowedTags: null,
          rateLimitRpm: null,
        },
      ],
    },
    mcpServers: {
      demo1: { transport: 'streamable-http', url: upstream1.url, enabled: true },
      demo2: { transport: 'streamable-http', url: upstream2.url, enabled: true },
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
  await upstream1.close();
  await upstream2.close();
});

test('project allowlist restricts visible providers and calls', async () => {
  const client = new Client({ name: 'projects-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(router.url), {
    requestInit: { headers: { Authorization: 'Bearer token-p1' } },
  });
  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providersJson = providers.structuredContent as any;
  expect(providersJson.providers.map((p: any) => p.name)).toEqual(['demo1']);

  const okCall = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'demo1', name: 'echo', arguments: { message: 'ok' } },
  });
  expect((okCall.structuredContent as any).structuredContent.message).toBe('ok');

  let denied = false;
  try {
    await client.callTool({
      name: 'tools.call',
      arguments: { provider: 'demo2', name: 'echo', arguments: { message: 'nope' } },
    });
  } catch (err: any) {
    denied = true;
    expect(String(err?.message ?? err)).toMatch(/not allowed/i);
  }
  expect(denied).toBe(true);

  await client.close();
});
