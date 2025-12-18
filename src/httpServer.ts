import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { NormalizedRouterConfig } from './config.js';
import { authFromToken, parseBearerOrApiKey } from './auth.js';
import { createRouterMcpServer } from './routerServer.js';
import type { Logger } from './log.js';
import type { UpstreamManager } from './upstream/httpUpstream.js';
import { createMetrics } from './metrics.js';

type StartHttpServerInput = {
  configRef: { current: NormalizedRouterConfig };
  upstreams: UpstreamManager;
  logger: Logger;
  host?: string;
  port?: number;
  path?: string;
  watchConfig?: boolean;
};

export async function startHttpServer(input: StartHttpServerInput): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const cfg0 = input.configRef.current;
  const listen = cfg0.listen.http;
  if (!listen) {
    throw new Error('HTTP listen is disabled in config');
  }

  const host = input.host ?? listen.host;
  const port = input.port ?? listen.port;
  const mcpPath = input.path ?? listen.path;
  const authEnabled = input.configRef.current.auth.tokens.length > 0;

  const metrics = createMetrics();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionToken: Record<string, string> = {};

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mcp-router', version: '0.1.0' });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  const deny = (res: express.Response, status: number, message: string) => {
    res.status(status).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  };

  const hasInitialize = (body: unknown) => {
    if (isInitializeRequest(body as any)) return true;
    if (Array.isArray(body)) return body.some((m) => isInitializeRequest(m as any));
    return false;
  };

  const ensureAuth = (req: express.Request) => {
    const token = parseBearerOrApiKey(req.headers as any);
    const principal = authFromToken(input.configRef.current, token);
    return { token, principal };
  };

  const getOrCreateTransport = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) return transports[sessionId];

    if (sessionId) {
      deny(res, 400, 'Invalid session');
      return null;
    }

    if (!hasInitialize(req.body)) {
      deny(res, 400, 'Missing session id (initialize first)');
      return null;
    }

    let token: string | null = null;
    let principal: ReturnType<typeof authFromToken>;
    try {
      ({ token, principal } = ensureAuth(req));
    } catch (err) {
      deny(res, 401, (err as Error).message);
      return null;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        if (authEnabled && token) sessionToken[id] = token;
        input.logger.info('http session initialized', { sessionId: id });
      },
      onsessionclosed: (id) => {
        delete transports[id];
        delete sessionToken[id];
        input.logger.info('http session closed', { sessionId: id });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionToken[transport.sessionId];
      }
    };

    const routerServer = createRouterMcpServer({
      configRef: input.configRef,
      principal,
      upstreams: input.upstreams,
      logger: input.logger,
      metrics,
    });

    await routerServer.connect(transport);
    return transport;
  };

  app.post(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (authEnabled && sessionId) {
      // Enforce auth for existing sessions as well.
      try {
        const { token } = ensureAuth(req);
        if (token && sessionToken[sessionId] && token !== sessionToken[sessionId]) {
          deny(res, 401, 'Token does not match session');
          return;
        }
      } catch (err) {
        deny(res, 401, (err as Error).message);
        return;
      }
    }

    const transport = await getOrCreateTransport(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res, req.body);
  });

  app.get(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      // Some clients may probe GET before initialization; per spec, GET SSE is optional.
      res.status(405).send('SSE stream is not available without an MCP session');
      return;
    }
    if (!transports[sessionId]) {
      res.status(404).send('Invalid session');
      return;
    }
    if (authEnabled) {
      try {
        const { token } = ensureAuth(req);
        if (token && sessionToken[sessionId] && token !== sessionToken[sessionId]) {
          res.status(401).send('Token does not match session');
          return;
        }
      } catch (err) {
        res.status(401).send((err as Error).message);
        return;
      }
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete(mcpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing mcp-session-id');
      return;
    }
    if (!transports[sessionId]) {
      res.status(404).send('Invalid session');
      return;
    }
    if (authEnabled) {
      try {
        const { token } = ensureAuth(req);
        if (token && sessionToken[sessionId] && token !== sessionToken[sessionId]) {
          res.status(401).send('Token does not match session');
          return;
        }
      } catch (err) {
        res.status(401).send((err as Error).message);
        return;
      }
    }
    await transports[sessionId].handleRequest(req, res);
  });

  const server = http.createServer(app);

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port already in use: ${host}:${port}. Change it in config (listen.http.port) or pass --port. You can also set port=0 for auto.`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(`http://${host}:${addr.port}${mcpPath}`);
      } else {
        resolve(`http://${host}:${port}${mcpPath}`);
      }
    });
  });

  input.logger.info('http listening', { url, healthz: `http://${host}:${(server.address() as any).port}/healthz` });

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await input.upstreams.closeAll();
  };

  return { url, close };
}
