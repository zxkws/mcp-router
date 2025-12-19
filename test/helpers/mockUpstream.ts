import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export async function startMockUpstream(
  label = 'mock',
  opts?: { failEcho?: boolean; failRequestsAfterInit?: boolean },
) {
  const app = express();
  app.use(express.json());
  const failEcho = opts?.failEcho ?? false;
  const failRequestsAfterInit = opts?.failRequestsAfterInit ?? false;

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (sessionId && transport && failRequestsAfterInit) {
      res.status(500).send('mock upstream failure (post-init)');
      return;
    }

    if (!transport) {
      if (sessionId) {
        res.status(400).send('Invalid session');
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).send('Initialize first');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
        onsessionclosed: (id) => {
          delete transports[id];
        },
      });

      const server = new McpServer({ name: `mock-upstream:${label}`, version: '1.0.0' });
      server.registerTool(
        'echo',
        {
          title: 'Echo',
          description: 'Echo input message',
          inputSchema: { message: z.string() },
          outputSchema: { message: z.string(), upstream: z.string().optional() },
        },
        async ({ message }) => {
          if (failEcho) {
            throw new Error('mock upstream failure');
          }
          return {
            content: [{ type: 'text', text: message }],
            structuredContent: { message, upstream: label },
          };
        },
      );
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('Invalid session');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('Invalid session');
      return;
    }
    await transport.handleRequest(req, res);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock upstream');

  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    label,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
