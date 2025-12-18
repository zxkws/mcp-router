import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockUpstream } from './helpers/mockUpstream.js';

let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let tempDir: string;

beforeAll(async () => {
  upstream = await startMockUpstream();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-router-test-'));
  const configPath = path.join(tempDir, 'mcp-router.config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        listen: { http: { port: 0, path: '/mcp' }, stdio: true },
        auth: { tokens: [{ value: 'dev-token' }] },
        mcpServers: { demo: { transport: 'streamable-http', url: upstream.url, enabled: true } },
      },
      null,
      2,
    ),
  );
});

afterAll(async () => {
  await upstream.close();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('stdio mode: router works via StdioClientTransport', async () => {
  const configPath = path.join(tempDir, 'mcp-router.config.json');
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      path.resolve('dist/cli.js'),
      'stdio',
      '--config',
      configPath,
      '--token',
      'dev-token',
      '--no-watch',
    ],
  });

  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providersJson = providers.structuredContent as any;
  expect(providersJson.providers.map((p: any) => p.name)).toContain('demo');

  const call = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'demo', name: 'echo', arguments: { message: 'hi' } },
  });
  const callJson = call.structuredContent as any;
  expect(callJson.structuredContent.message).toBe('hi');

  await client.close();
});
