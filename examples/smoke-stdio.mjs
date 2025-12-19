#!/usr/bin/env node
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const token = process.env.MCP_ROUTER_TOKEN ?? 'dev-token';
const provider = process.env.MCP_ROUTER_PROVIDER ?? 'demo';
const configPath = process.env.MCP_ROUTER_CONFIG ?? path.resolve('mcp-router.config.json');

async function main() {
  const client = new Client({ name: 'mcp-router-smoke-stdio', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.resolve('dist/cli.js'), 'stdio', '--config', configPath, '--token', token, '--no-watch'],
  });

  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providerNames = (providers.structuredContent?.providers ?? []).map((p) => p.name);
  if (!providerNames.includes(provider)) {
    throw new Error(`provider not found in list_providers: ${provider} (got: ${providerNames.join(', ')})`);
  }

  const call = await client.callTool({
    name: 'tools.call',
    arguments: { provider, name: 'echo', arguments: { message: 'hello' } },
  });
  const msg = call.structuredContent?.structuredContent?.message;
  if (msg !== 'hello') {
    throw new Error(`unexpected echo response: ${JSON.stringify(call.structuredContent)}`);
  }

  await client.close();
  // eslint-disable-next-line no-console
  console.log('[smoke-stdio] OK');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-stdio] FAIL:', err.stack || err.message);
  process.exit(1);
});

