import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-router-upstream-stdio-test-'));
  const configPath = path.join(tempDir, 'mcp-router.config.json');
  const upstreamFixture = path.resolve('test/fixtures/stdioUpstreamServer.mjs');

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        listen: { http: { port: 0, path: '/mcp' }, stdio: true },
        auth: { tokens: [{ value: 'dev-token' }] },
        mcpServers: {
          demo: {
            transport: 'stdio',
            command: 'node',
            args: [upstreamFixture],
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  );
});

afterAll(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('router stdio -> upstream stdio works', async () => {
  const configPath = path.join(tempDir, 'mcp-router.config.json');
  const client = new Client({ name: 'stdio-upstream-test-client', version: '1.0.0' });
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

  const call = await client.callTool({
    name: 'tools.call',
    arguments: { provider: 'demo', name: 'echo', arguments: { message: 'upstream-stdio' } },
  });
  const callJson = call.structuredContent as any;
  expect(callJson.structuredContent.message).toBe('upstream-stdio');

  await client.close();
});

