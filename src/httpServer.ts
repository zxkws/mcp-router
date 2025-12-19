import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { NormalizedRouterConfig } from './config.js';
import { authFromToken, parseBearerOrApiKey } from './auth.js';
import { createRouterServer } from './routerServer.js';
import type { Logger } from './log.js';
import type { UpstreamManager } from './upstream/manager.js';
import { createMetrics } from './metrics.js';
import { TokenBucketRateLimiter } from './rateLimit.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { startHealthChecker } from './healthChecker.js';
import { loadConfigFile, parseRouterConfig } from './config.js';
import { mergeServers, parseImportText, type ImportFormat } from './importer.js';

type StartHttpServerInput = {
  configRef: { current: NormalizedRouterConfig };
  upstreams: UpstreamManager;
  logger: Logger;
  random?: () => number;
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
  const rateLimiter = new TokenBucketRateLimiter();
  const breaker = new CircuitBreaker(
    () => input.configRef.current.routing.circuitBreaker,
    {
      onStateChange: (serverName, state) => metrics.setCircuitState({ server: serverName, state }),
      onOpen: (serverName) => metrics.incCircuitOpen({ server: serverName }),
      onFailure: (serverName) => metrics.incUpstreamFailure({ server: serverName }),
    },
  );
  const healthChecker = startHealthChecker({
    configRef: input.configRef,
    upstreams: input.upstreams,
    breaker,
    logger: input.logger,
    metrics: {
      setUpstreamHealth: metrics.setUpstreamHealth,
      incHealthCheck: ({ server, ok }) => metrics.incHealthCheck({ server, ok }),
    },
  });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionToken: Record<string, string> = {};
  const sseTransports: Record<string, SSEServerTransport> = {};
  const sseSessionToken: Record<string, string> = {};

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

  const normalizeAdminPath = (p: string) => {
    if (!p.startsWith('/')) return `/${p}`;
    return p.replace(/\/+$/, '') || '/admin';
  };

  const normalizeImportFormat = (value: unknown): ImportFormat => {
    const allowed: ImportFormat[] = ['auto', 'router', 'claude', 'codex', 'gemini', '1mcp', 'json'];
    if (typeof value !== 'string') return 'auto';
    const lowered = value.toLowerCase() as ImportFormat;
    return allowed.includes(lowered) ? lowered : 'auto';
  };

  const normalizeConflict = (value: unknown): 'rename' | 'skip' | 'overwrite' => {
    if (value === 'skip' || value === 'overwrite' || value === 'rename') return value;
    return 'rename';
  };

  const adminConfig = input.configRef.current.admin;
  const adminPath = normalizeAdminPath(adminConfig.path);

  const ensureAdminAuth = (req: express.Request, res: express.Response): boolean => {
    if (adminConfig.allowUnauthenticated) return true;
    if (input.configRef.current.auth.tokens.length === 0) {
      res.status(401).send('Admin requires auth; set admin.allowUnauthenticated=true to bypass');
      return false;
    }
    try {
      const token = parseBearerOrApiKey(req.headers as any);
      authFromToken(input.configRef.current, token);
      return true;
    } catch (err) {
      res.status(401).send((err as Error).message);
      return false;
    }
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

  const renderAdminPage = () => {
    const authHint = adminConfig.allowUnauthenticated
      ? '(optional)'
      : input.configRef.current.auth.tokens.length > 0
        ? '(required)'
        : '(required - no tokens configured)';
    const adminBase = adminPath;
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mcp-router admin</title>
    <style>
      :root {
        --ink: #0c1218;
        --muted: #55616e;
        --accent: #1b6c8e;
        --accent-2: #2d996b;
        --card: rgba(255, 255, 255, 0.88);
        --border: rgba(12, 18, 24, 0.12);
        --shadow: 0 20px 60px rgba(12, 18, 24, 0.15);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Avenir", "Gill Sans", "Trebuchet MS", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at 20% 10%, #f7f1e6 0%, #f1f6fa 45%, #e8f0ee 100%);
        min-height: 100vh;
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 40px 24px 64px;
      }
      header {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 28px;
      }
      h1 {
        font-weight: 700;
        letter-spacing: -0.02em;
        font-size: 32px;
        margin: 0;
      }
      .subtitle {
        color: var(--muted);
        font-size: 16px;
      }
      .grid {
        display: grid;
        gap: 20px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px 18px 22px;
        box-shadow: var(--shadow);
      }
      label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        display: block;
        margin-bottom: 6px;
      }
      input, select, textarea {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        font-size: 14px;
        font-family: inherit;
      }
      textarea {
        min-height: 220px;
        resize: vertical;
      }
      .row {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .buttons {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      button {
        border: none;
        padding: 12px 18px;
        border-radius: 999px;
        font-weight: 600;
        cursor: pointer;
        background: var(--accent);
        color: white;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        box-shadow: 0 8px 18px rgba(27, 108, 142, 0.25);
      }
      button.secondary {
        background: var(--accent-2);
        box-shadow: 0 8px 18px rgba(45, 153, 107, 0.25);
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        box-shadow: none;
      }
      .meta {
        font-size: 13px;
        color: var(--muted);
      }
      .output {
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
      }
      .pill {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(27, 108, 142, 0.12);
        color: var(--accent);
        font-size: 12px;
        font-weight: 600;
      }
      .note {
        font-size: 12px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>mcp-router admin</h1>
        <div class="subtitle">Import MCP servers from Claude, Codex, Gemini, or raw JSON/TOML and merge into your router config.</div>
        <div class="meta">Admin path: ${adminBase}</div>
      </header>
      <div class="grid">
        <div class="card">
          <label for="text">Paste config (JSON/TOML)</label>
          <textarea id="text" placeholder="Paste config here..."></textarea>
          <div class="note">Tip: you can also drop a file or use the picker below.</div>
          <input id="file" type="file" />
        </div>
        <div class="card">
          <div class="row">
            <div>
              <label for="format">Format</label>
              <select id="format">
                <option value="auto">auto</option>
                <option value="claude">claude (json)</option>
                <option value="codex">codex (toml)</option>
                <option value="gemini">gemini (json)</option>
                <option value="1mcp">1mcp (json)</option>
                <option value="router">mcp-router (json)</option>
                <option value="json">generic (json)</option>
              </select>
            </div>
            <div>
              <label for="conflict">Conflict</label>
              <select id="conflict">
                <option value="rename">rename</option>
                <option value="skip">skip</option>
                <option value="overwrite">overwrite</option>
              </select>
            </div>
          </div>
          <div class="row">
            <div>
              <label for="prefix">Name prefix</label>
              <input id="prefix" placeholder="optional" />
            </div>
            <div>
              <label for="tags">Add tags</label>
              <input id="tags" placeholder="tag-a, tag-b" />
            </div>
          </div>
          <div class="row">
            <div>
              <label for="token">Auth token ${authHint}</label>
              <input id="token" placeholder="Bearer token" />
            </div>
          </div>
          <div class="buttons">
            <button id="preview">Preview</button>
            <button id="apply" class="secondary">Import</button>
          </div>
          <div class="meta" id="status">Loading state...</div>
        </div>
        <div class="card">
          <label>Result</label>
          <div class="output" id="output">No results yet.</div>
        </div>
      </div>
    </div>
    <script>
      const adminBase = ${JSON.stringify(adminBase)};
      const statusEl = document.getElementById('status');
      const outputEl = document.getElementById('output');
      const textEl = document.getElementById('text');
      const fileEl = document.getElementById('file');
      const formatEl = document.getElementById('format');
      const conflictEl = document.getElementById('conflict');
      const prefixEl = document.getElementById('prefix');
      const tagsEl = document.getElementById('tags');
      const tokenEl = document.getElementById('token');
      const previewBtn = document.getElementById('preview');
      const applyBtn = document.getElementById('apply');

      const setStatus = (msg) => { statusEl.textContent = msg; };
      const setOutput = (msg) => { outputEl.textContent = msg; };
      const getHeaders = () => {
        const headers = { 'Content-Type': 'application/json' };
        const token = tokenEl.value.trim();
        if (token) headers['Authorization'] = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
        return headers;
      };
      const tags = () => tagsEl.value.split(/[,\\s]+/).map(t => t.trim()).filter(Boolean);
      const buildPayload = (dryRun) => ({
        text: textEl.value,
        format: formatEl.value,
        conflict: conflictEl.value,
        prefix: prefixEl.value,
        tags: tags(),
        dryRun
      });

      async function loadState() {
        try {
          const res = await fetch(adminBase + '/state', { headers: getHeaders() });
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          setStatus('Config: ' + data.configPath + ' | servers: ' + data.serverCount);
        } catch (err) {
          setStatus('State unavailable: ' + err.message);
        }
      }

      async function runImport(dryRun) {
        if (!textEl.value.trim()) {
          setOutput('Paste or load a config first.');
          return;
        }
        previewBtn.disabled = true;
        applyBtn.disabled = true;
        setOutput('Running...');
        try {
          const res = await fetch(adminBase + '/import', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(buildPayload(dryRun))
          });
          const body = await res.text();
          if (!res.ok) throw new Error(body);
          const data = JSON.parse(body);
          const lines = [
            'Format: ' + data.format,
            'Existing servers: ' + data.existingCount,
            'Merged servers: ' + data.mergedCount,
            'Added: ' + data.stats.added + ' | Renamed: ' + data.stats.renamed + ' | Overwritten: ' + data.stats.overwritten + ' | Deduped: ' + data.stats.deduped + ' | Skipped: ' + data.stats.skipped,
          ];
          if (data.result.renamed.length) lines.push('Renamed: ' + data.result.renamed.map(r => r.from + '->' + r.to).join(', '));
          if (data.result.deduped.length) lines.push('Deduped: ' + data.result.deduped.map(d => d.name + '~' + d.existing).join(', '));
          if (data.warnings.length) lines.push('Warnings:\\n' + data.warnings.join('\\n'));
          if (!dryRun) lines.push('Import applied.');
          setOutput(lines.join('\\n'));
          await loadState();
        } catch (err) {
          setOutput('Error: ' + err.message);
        } finally {
          previewBtn.disabled = false;
          applyBtn.disabled = false;
        }
      }

      previewBtn.addEventListener('click', () => runImport(true));
      applyBtn.addEventListener('click', () => runImport(false));

      fileEl.addEventListener('change', async () => {
        const file = fileEl.files && fileEl.files[0];
        if (!file) return;
        textEl.value = await file.text();
        setStatus('Loaded file: ' + file.name);
      });

      loadState();
    </script>
  </body>
</html>`;
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

    const routerServer = createRouterServer({
      configRef: input.configRef,
      principal,
      upstreams: input.upstreams,
      logger: input.logger,
      random: input.random,
      breaker,
      health: healthChecker,
      rateLimiter,
      metrics,
    });

    await routerServer.connect(transport);
    return transport;
  };

  if (adminConfig.enabled) {
    app.get(adminPath, (req, res) => {
      if (!ensureAdminAuth(req, res)) return;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderAdminPage());
    });

    app.get(`${adminPath}/state`, (req, res) => {
      if (!ensureAdminAuth(req, res)) return;
      const cfg = input.configRef.current;
      res.json({
        ok: true,
        configPath: cfg.configPath,
        serverCount: Object.keys(cfg.mcpServers).length,
        servers: Object.keys(cfg.mcpServers),
      });
    });

    app.post(`${adminPath}/import`, async (req, res) => {
      if (!ensureAdminAuth(req, res)) return;
      const body = req.body as {
        text?: string;
        format?: string;
        conflict?: string;
        prefix?: string;
        tags?: string[];
        dryRun?: boolean;
      };
      if (!body || typeof body.text !== 'string' || body.text.trim().length === 0) {
        res.status(400).send('Missing text');
        return;
      }
      try {
        const parsed = parseImportText(body.text, { format: normalizeImportFormat(body.format) });
        const configPath = input.configRef.current.configPath;
        const rawText = await fs.readFile(configPath, 'utf8');
        const rawJson = JSON.parse(rawText);
        const rawConfig = parseRouterConfig(rawJson);
        const targetKey = rawConfig.mcpServers
          ? 'mcpServers'
          : rawConfig.upstreams
            ? 'upstreams'
            : 'mcpServers';
        const existing = (rawConfig as any)[targetKey] ?? {};
        const tagList = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [];
        const { merged, result } = mergeServers(existing, parsed.servers, {
          conflict: normalizeConflict(body.conflict),
          namePrefix: body.prefix ?? '',
          addTags: tagList,
        });
        const updated: any = { ...rawConfig, [targetKey]: merged };
        if (targetKey === 'mcpServers') delete updated.upstreams;
        parseRouterConfig(updated);
        if (!body.dryRun) {
          await fs.writeFile(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
          input.configRef.current = loadConfigFile(configPath);
        }
        res.json({
          ok: true,
          format: parsed.format,
          existingCount: Object.keys(existing).length,
          mergedCount: Object.keys(merged).length,
          stats: {
            added: result.added.length,
            renamed: result.renamed.length,
            skipped: result.skipped.length,
            deduped: result.deduped.length,
            overwritten: result.overwritten.length,
          },
          result,
          warnings: [...parsed.warnings, ...result.warnings],
        });
      } catch (err) {
        res.status(400).send((err as Error).message);
      }
    });
  }

  // ===========================================================================
  // Deprecated HTTP+SSE transport (protocol version 2024-11-05)
  // - GET  /sse       establishes SSE stream and emits "endpoint" event
  // - POST /messages  accepts JSON-RPC with ?sessionId=<id>
  // ===========================================================================
  app.get('/sse', async (req, res) => {
    let token: string | null = null;
    let principal: ReturnType<typeof authFromToken>;
    try {
      ({ token, principal } = ensureAuth(req));
    } catch (err) {
      res.status(401).send((err as Error).message);
      return;
    }

    const transport = new SSEServerTransport('/messages', res);
    const sid = transport.sessionId;
    sseTransports[sid] = transport;
    if (authEnabled && token) sseSessionToken[sid] = token;

    transport.onclose = () => {
      if (!sseTransports[sid]) return;
      delete sseTransports[sid];
      delete sseSessionToken[sid];
      input.logger.info('sse session closed', { sessionId: sid });
    };

    const routerServer = createRouterServer({
      configRef: input.configRef,
      principal,
      upstreams: input.upstreams,
      logger: input.logger,
      random: input.random,
      breaker,
      health: healthChecker,
      rateLimiter,
      metrics,
    });

    input.logger.info('sse session initialized', { sessionId: sid });
    await routerServer.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = (req.query.sessionId as string | undefined) ?? undefined;
    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const transport = sseTransports[sessionId];
    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    if (authEnabled) {
      try {
        const { token } = ensureAuth(req);
        if (token && sseSessionToken[sessionId] && token !== sseSessionToken[sessionId]) {
          res.status(401).send('Token does not match session');
          return;
        }
      } catch (err) {
        res.status(401).send((err as Error).message);
        return;
      }
    }

    await transport.handlePostMessage(req, res, req.body);
  });

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
    healthChecker.stop();
    await Promise.allSettled(Object.values(transports).map((t) => t.close()));
    for (const sid of Object.keys(transports)) delete transports[sid];
    for (const sid of Object.keys(sessionToken)) delete sessionToken[sid];

    await Promise.allSettled(Object.values(sseTransports).map((t) => t.close()));
    for (const sid of Object.keys(sseTransports)) delete sseTransports[sid];
    for (const sid of Object.keys(sseSessionToken)) delete sseSessionToken[sid];

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await input.upstreams.closeAll();
  };

  return { url, close };
}
