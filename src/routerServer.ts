import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import semver from 'semver';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { NormalizedRouterConfig } from './config.js';
import { assertAllowedMcpServer } from './auth.js';
import type { AuthedPrincipal } from './types.js';
import type { Logger } from './log.js';
import type { UpstreamManager } from './upstream/manager.js';
import type { TokenBucketRateLimiter } from './rateLimit.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { UpstreamHealthSnapshot } from './healthChecker.js';

export type RouterRuntime = {
  configRef: { current: NormalizedRouterConfig };
  principal: AuthedPrincipal;
  upstreams: UpstreamManager;
  logger: Logger;
  random?: () => number;
  breaker: CircuitBreaker;
  health?: { snapshot: (server: string) => UpstreamHealthSnapshot };
  rateLimiter?: TokenBucketRateLimiter;
  metrics?: {
    observeToolCall: (labels: { server: string; tool: string; ok: boolean }, seconds: number) => void;
    setCircuitState?: (labels: { server: string; state: 'closed' | 'open' | 'half-open' }) => void;
    incCircuitOpen?: (labels: { server: string }) => void;
    incUpstreamFailure?: (labels: { server: string }) => void;
  };
};

type UpstreamTool = Tool & { name: string };

function enabledServers(cfg: NormalizedRouterConfig, principal: AuthedPrincipal) {
  const entries = Object.entries(cfg.mcpServers).filter(([, v]) => v.enabled);
  if (!principal.enabled) return entries;
  return entries.filter(([name, server]) => {
    if (principal.allowedMcpServers && !principal.allowedMcpServers.has(name)) return false;
    if (principal.allowedTags && (!server.tags || !server.tags.some((t) => principal.allowedTags!.has(t)))) return false;
    return true;
  });
}

function normalizeVersionRange(range: string): string {
  const normalized = semver.validRange(range.trim());
  if (!normalized) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid version range: ${range}`);
  }
  return normalized;
}

function matchesVersion(serverVersion: string | undefined, range: string | null): boolean {
  if (!range) return true;
  if (!serverVersion) return false;
  const v = semver.valid(serverVersion);
  if (!v) return false;
  try {
    return semver.satisfies(v, range);
  } catch {
    return false;
  }
}

function jsonText(content: unknown): CallToolResult['content'] {
  return [{ type: 'text', text: JSON.stringify(content, null, 2) }];
}

function tokenFingerprint(principal: AuthedPrincipal): string {
  if (!principal.enabled) return 'anonymous';
  const h = createHash('sha256').update(principal.token).digest('hex');
  return h.slice(0, 12);
}

function safeJsonSnippet(value: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + '…';
  } catch {
    return '[unserializable]';
  }
}

function findProviderForToolName(cfg: NormalizedRouterConfig, toolName: string): { provider: string; rest: string } | null {
  // Prefer longest matching provider prefix to allow provider names that contain dots.
  const providers = Object.keys(cfg.mcpServers).sort((a, b) => b.length - a.length);
  for (const p of providers) {
    const prefix = p + '.';
    if (toolName.startsWith(prefix)) {
      return { provider: p, rest: toolName.slice(prefix.length) };
    }
  }
  return null;
}

function sanitizeToolSegment(name: string) {
  // Allowed: A-Z a-z 0-9 _ - .
  let out = '';
  for (const ch of name) {
    const ok =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '-' ||
      ch === '.';
    out += ok ? ch : '_';
  }
  out = out.replace(/^\.+/, '_').replace(/\.+$/, '_');
  return out.length > 0 ? out : '_';
}

export function createRouterServer(runtime: RouterRuntime) {
  const server = new Server(
    { name: 'mcp-router', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );

  const breaker = runtime.breaker;

  const upstreamToolCache = new Map<
    string,
    { fetchedAt: number; tools: UpstreamTool[]; nameMap: Map<string, string> }
  >();
  const cacheTtlMs = 30_000;
  const selectorCounters = new Map<string, number>();

  const resolveProviderSelector = (cfg: NormalizedRouterConfig, principal: AuthedPrincipal, selector: string) => {
    const raw = selector.trim();
    if (!raw) throw new McpError(ErrorCode.InvalidParams, 'Empty provider selector');

    // Fast path: explicit provider name.
    if (!raw.startsWith('tag:') && !raw.startsWith('version:')) return raw;

    let tag: string | null = null;
    let range: string | null = null;

    if (raw.startsWith('tag:')) {
      const rest = raw.slice('tag:'.length).trim();
      if (!rest) throw new McpError(ErrorCode.InvalidParams, 'Empty tag selector');
      const at = rest.indexOf('@');
      if (at === -1) {
        tag = rest;
      } else {
        tag = rest.slice(0, at).trim();
        range = normalizeVersionRange(rest.slice(at + 1));
        if (!tag) throw new McpError(ErrorCode.InvalidParams, 'Empty tag selector');
      }
    } else if (raw.startsWith('version:')) {
      range = normalizeVersionRange(raw.slice('version:'.length));
    }

    const matches = enabledServers(cfg, principal)
      .filter(([, s]) => (tag ? (s.tags ?? []).includes(tag) : true))
      .filter(([, s]) => matchesVersion(s.version, range))
      .sort(([a], [b]) => a.localeCompare(b));

    if (matches.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `No providers match selector: ${raw}`);
    }

    const candidates = matches.filter(([name]) => breaker.canAttempt(name));
    if (candidates.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, `All providers matching selector are temporarily unavailable: ${raw}`);
    }

    const strategy = cfg.routing.selectorStrategy;
    if (strategy === 'random') {
      const rnd = runtime.random ?? Math.random;
      const r = rnd();
      const idx = Math.min(candidates.length - 1, Math.max(0, Math.floor(r * candidates.length)));
      return candidates[idx]![0];
    }

    const key = `selector:${raw}`;
    const cur = selectorCounters.get(key) ?? 0;
    selectorCounters.set(key, cur + 1);
    const idx = cur % candidates.length;
    return candidates[idx]![0];
  };

  const getUpstreamToolsCached = async (provider: string) => {
    const cfg = runtime.configRef.current;
    assertAllowedMcpServer(cfg, runtime.principal, provider);
    const upstream = cfg.mcpServers[provider];
    if (!upstream || !upstream.enabled) throw new Error(`Unknown provider: ${provider}`);

    const cached = upstreamToolCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) return cached;

    let attempt: { end: (ok: boolean) => void } | null = null;
    try {
      try {
        attempt = breaker.beginAttempt(provider);
      } catch (err) {
        if ((err as Error).message === 'CIRCUIT_OPEN' || (err as Error).message === 'CIRCUIT_HALF_OPEN_BUSY') {
          throw new McpError(ErrorCode.InvalidRequest, `Upstream temporarily unavailable: ${provider}`);
        }
        throw err;
      }
      const client = runtime.upstreams.getClient(provider, upstream);
      const tools = await client.listTools();

      const nameMap = new Map<string, string>();
      const namespacedTools: UpstreamTool[] = tools.tools.map((t: any) => {
        const sanitized = sanitizeToolSegment(String(t.name));
        const namespacedName = `${provider}.${sanitized}`;
        nameMap.set(namespacedName, String(t.name));
        return {
          ...t,
          name: namespacedName,
          _meta: {
            ...(t._meta ?? {}),
            'mcp-router/upstreamToolName': String(t.name),
            'mcp-router/provider': provider,
          },
        };
      });

      const entry = { fetchedAt: Date.now(), tools: namespacedTools, nameMap };
      upstreamToolCache.set(provider, entry);
      attempt.end(true);
      return entry;
    } catch (err) {
      if (attempt) {
        if (err instanceof McpError && err.code !== ErrorCode.InternalError) {
          attempt.end(true);
        } else {
          attempt.end(false);
        }
      }
      throw err;
    }
  };

  const baseTools: Tool[] = [
    {
      name: 'list_providers',
      title: 'List Providers',
      description: 'List configured upstream MCP servers (providers).',
      inputSchema: {
        type: 'object',
        properties: { tag: { type: 'string' }, version: { type: 'string' } },
      },
    },
    {
      name: 'tools.list',
      title: 'List Tools (by provider)',
      description:
        'List tools for a given provider (upstream MCP server). provider can be a name, "tag:<tag>" or "tag:<tag>@<range>", or "version:<range>".',
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string' } },
        required: ['provider'],
      },
    },
    {
      name: 'tools.call',
      title: 'Call Tool (by provider)',
      description:
        'Call a tool on a given provider (upstream MCP server). provider can be a name, "tag:<tag>" or "tag:<tag>@<range>", or "version:<range>".',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          name: { type: 'string' },
          arguments: {},
        },
        required: ['provider', 'name'],
      },
    },
    {
      name: 'tools.refresh',
      title: 'Refresh Tool Cache',
      description: 'Refresh cached upstream tool metadata for namespaced tool exposure.',
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string' } },
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cfg = runtime.configRef.current;
    runtime.rateLimiter?.consume(runtime.principal);
    if (cfg.audit.enabled) {
      runtime.logger.info('audit.tools_list', {
        token: tokenFingerprint(runtime.principal),
        projectId: runtime.principal.enabled ? runtime.principal.projectId : null,
        exposure: cfg.toolExposure,
      });
    }
    const exposure = cfg.toolExposure;

    const enabled = enabledServers(cfg, runtime.principal);
    if (exposure === 'hierarchical') {
      return { tools: baseTools };
    }

    const namespaced: Tool[] = [];
    for (const [provider] of enabled) {
      try {
        const entry = await getUpstreamToolsCached(provider);
        namespaced.push(...entry.tools);
      } catch (err) {
        runtime.logger.warn('failed to list upstream tools for namespaced exposure', {
          provider,
          message: (err as Error).message,
        });
      }
    }

    if (exposure === 'namespaced') {
      // Keep list_providers even in namespaced mode for discovery/debuggability.
      const lp = baseTools.find((t) => t.name === 'list_providers')!;
      return { tools: [lp, ...namespaced] };
    }
    return { tools: [...baseTools, ...namespaced] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const cfg = runtime.configRef.current;
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as any;
    const auditEnabled = cfg.audit.enabled;
    const sessionId = extra.sessionId ?? null;
    const requestId = (request as any).id ?? null;

    const start = performance.now();
    let ok = false;
    let metricServer = 'router';
    let metricTool = toolName;

    try {
      runtime.rateLimiter?.consume(runtime.principal);
      if (auditEnabled) {
        runtime.logger.info('audit.tool_start', {
          token: tokenFingerprint(runtime.principal),
          projectId: runtime.principal.enabled ? runtime.principal.projectId : null,
          sessionId,
          requestId,
          tool: toolName,
          args: cfg.audit.logArguments ? safeJsonSnippet(args, cfg.audit.maxArgumentChars) : undefined,
        });
      }
      if (toolName === 'list_providers') {
        const tag = args?.tag ? String(args.tag) : null;
        const version = args?.version ? normalizeVersionRange(String(args.version)) : null;
        const providers = enabledServers(cfg, runtime.principal).map(([name, s]) => ({
          name,
          url: s.url,
          transport: s.transport,
          tags: s.tags,
          version: s.version,
          circuitBreaker: breaker.snapshot(name),
          health: runtime.health?.snapshot(name),
        }));
        const filtered = providers
          .filter((p) => (tag ? (p.tags ?? []).includes(tag) : true))
          .filter((p) => matchesVersion(p.version, version));
        ok = true;
        return {
          content: jsonText({ providers: filtered }),
          structuredContent: { providers: filtered },
        };
      }

      if (toolName === 'tools.list') {
        const provider = String(args.provider ?? '');
        if (!provider) throw new McpError(ErrorCode.InvalidParams, 'Missing provider');
        const resolvedProvider = resolveProviderSelector(cfg, runtime.principal, provider);
        assertAllowedMcpServer(cfg, runtime.principal, resolvedProvider);
        const upstream = cfg.mcpServers[resolvedProvider];
        if (!upstream || !upstream.enabled) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown provider: ${resolvedProvider}`);
        }
        let attempt: { end: (ok: boolean) => void } | null = null;
        try {
          attempt = breaker.beginAttempt(resolvedProvider);
          const client = runtime.upstreams.getClient(resolvedProvider, upstream);
          const tools = await client.listTools();
          attempt.end(true);
          ok = true;
          metricServer = resolvedProvider;
          metricTool = 'tools.list';
          return {
            content: jsonText({ provider: resolvedProvider, tools: tools.tools }),
            structuredContent: { provider: resolvedProvider, tools: tools.tools },
          };
        } catch (err) {
          if (attempt) {
            if (err instanceof McpError && err.code !== ErrorCode.InternalError) {
              attempt.end(true);
            } else {
              attempt.end(false);
            }
          }
          if ((err as Error).message === 'CIRCUIT_OPEN' || (err as Error).message === 'CIRCUIT_HALF_OPEN_BUSY') {
            throw new McpError(ErrorCode.InvalidRequest, `Upstream temporarily unavailable: ${resolvedProvider}`);
          }
          throw err;
        }
      }

      if (toolName === 'tools.call') {
        const provider = String(args.provider ?? '');
        const name = String(args.name ?? '');
        if (!provider || !name) throw new McpError(ErrorCode.InvalidParams, 'Missing provider or name');
        const resolvedProvider = resolveProviderSelector(cfg, runtime.principal, provider);
        assertAllowedMcpServer(cfg, runtime.principal, resolvedProvider);
        const upstream = cfg.mcpServers[resolvedProvider];
        if (!upstream || !upstream.enabled) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown provider: ${resolvedProvider}`);
        }
        let attempt: { end: (ok: boolean) => void } | null = null;
        try {
          attempt = breaker.beginAttempt(resolvedProvider);
          const client = runtime.upstreams.getClient(resolvedProvider, upstream);
          const result = await client.callTool({ name, arguments: args.arguments ?? {} });
          attempt.end(true);
          ok = true;
          metricServer = resolvedProvider;
          metricTool = name;
          return {
            content: jsonText({
              provider: resolvedProvider,
              name,
              content: result.content,
              structuredContent: result.structuredContent,
            }),
            structuredContent: {
              provider: resolvedProvider,
              name,
              content: result.content,
              structuredContent: result.structuredContent,
            },
          };
        } catch (err) {
          if (attempt) {
            if (err instanceof McpError && err.code !== ErrorCode.InternalError) {
              attempt.end(true);
            } else {
              attempt.end(false);
            }
          }
          if ((err as Error).message === 'CIRCUIT_OPEN' || (err as Error).message === 'CIRCUIT_HALF_OPEN_BUSY') {
            throw new McpError(ErrorCode.InvalidRequest, `Upstream temporarily unavailable: ${resolvedProvider}`);
          }
          throw err;
        }
      }

      if (toolName === 'tools.refresh') {
        const provider = args.provider ? String(args.provider) : null;
        if (provider) {
          upstreamToolCache.delete(provider);
          await getUpstreamToolsCached(provider);
        } else {
          upstreamToolCache.clear();
        }
        ok = true;
        return { content: jsonText({ ok: true }), structuredContent: { ok: true } };
      }

      // Namespaced tools: <provider>.<tool>
      const parsed = findProviderForToolName(cfg, toolName);
      if (!parsed) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      }
      const { provider } = parsed;
      assertAllowedMcpServer(cfg, runtime.principal, provider);
      const upstream = cfg.mcpServers[provider];
      if (!upstream || !upstream.enabled) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown provider: ${provider}`);
      }

      const cacheEntry = await getUpstreamToolsCached(provider);
      const upstreamToolName = cacheEntry.nameMap.get(toolName) ?? parsed.rest;

      let attempt: { end: (ok: boolean) => void } | null = null;
      try {
        attempt = breaker.beginAttempt(provider);
        const client = runtime.upstreams.getClient(provider, upstream);
        const result = await client.callTool({ name: upstreamToolName, arguments: args });
        attempt.end(true);
        ok = true;
        metricServer = provider;
        metricTool = upstreamToolName;
        return result as any;
      } catch (err) {
        if (attempt) {
          if (err instanceof McpError && err.code !== ErrorCode.InternalError) {
            attempt.end(true);
          } else {
            attempt.end(false);
          }
        }
        if ((err as Error).message === 'CIRCUIT_OPEN' || (err as Error).message === 'CIRCUIT_HALF_OPEN_BUSY') {
          throw new McpError(ErrorCode.InvalidRequest, `Upstream temporarily unavailable: ${provider}`);
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      if ((err as any)?.code === 'RATE_LIMIT') {
        throw new McpError(ErrorCode.InvalidRequest, (err as Error).message);
      }
      throw new McpError(ErrorCode.InternalError, (err as Error).message);
    } finally {
      const seconds = (performance.now() - start) / 1000;
      runtime.metrics?.observeToolCall({ server: metricServer, tool: metricTool, ok }, seconds);
      if (auditEnabled) {
        runtime.logger.info('audit.tool_end', {
          token: tokenFingerprint(runtime.principal),
          projectId: runtime.principal.enabled ? runtime.principal.projectId : null,
          sessionId,
          requestId,
          tool: toolName,
          ok,
          seconds,
          upstream: metricServer !== 'router' ? metricServer : undefined,
          upstreamTool: metricServer !== 'router' ? metricTool : undefined,
        });
      }
    }
  });

  return server;
}
