#!/usr/bin/env node
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const port = Number(process.env.PORT ?? '9001');
const host = process.env.HOST ?? '127.0.0.1';
const path = process.env.PATHNAME ?? '/mcp';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const transports = {};

app.post(path, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? transports[String(sessionId)] : undefined;

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
        transports[id] = transport;
      },
      onsessionclosed: (id) => {
        delete transports[id];
      },
    });

    const server = new McpServer({ name: 'mock-upstream', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        title: 'Echo',
        description: 'Echo input message',
        inputSchema: { message: z.string() },
        outputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      }),
    );

    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get(path, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports[String(sessionId)] : undefined;
  if (!transport) {
    res.status(400).send('Invalid session');
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete(path, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports[String(sessionId)] : undefined;
  if (!transport) {
    res.status(400).send('Invalid session');
    return;
  }
  await transport.handleRequest(req, res);
});

const server = http.createServer(app);
server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-upstream] listening on http://${host}:${port}${path}`);
});

