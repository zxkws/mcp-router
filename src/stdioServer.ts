import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { NormalizedRouterConfig } from './config.js';
import { authFromToken } from './auth.js';
import { createRouterMcpServer } from './routerServer.js';
import type { Logger } from './log.js';
import type { UpstreamManager } from './upstream/httpUpstream.js';

export async function startStdioServer(input: {
  configRef: { current: NormalizedRouterConfig };
  token: string | null;
  upstreams: UpstreamManager;
  logger: Logger;
}) {
  const principal = authFromToken(input.configRef.current, input.token);
  const server = createRouterMcpServer({
    configRef: input.configRef,
    principal,
    upstreams: input.upstreams,
    logger: input.logger,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

