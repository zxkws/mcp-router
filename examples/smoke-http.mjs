#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_ROUTER_URL ?? 'http://127.0.0.1:8080/mcp');
const token = process.env.MCP_ROUTER_TOKEN ?? 'dev-token';
const provider = process.env.MCP_ROUTER_PROVIDER ?? 'demo';

async function main() {
  const client = new Client({ name: 'mcp-router-smoke-http', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  await client.connect(transport);

  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  const providerNames = (providers.structuredContent?.providers ?? []).map((p) => p.name);
  if (!providerNames.includes(provider)) {
    throw new Error(`provider not found in list_providers: ${provider} (got: ${providerNames.join(', ')})`);
  }

  const tools = await client.callTool({ name: 'tools.list', arguments: { provider } });
  const toolNames = (tools.structuredContent?.tools ?? []).map((t) => t.name);
  if (!toolNames.includes('echo')) {
    throw new Error(`echo tool not found in tools.list (got: ${toolNames.join(', ')})`);
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
  console.log('[smoke-http] OK');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-http] FAIL:', err.stack || err.message);
  process.exit(1);
});

