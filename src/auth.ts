import type { AuthedPrincipal } from './types.js';
import type { NormalizedRouterConfig } from './config.js';

function intersectAllowLists(a: string[] | null, b: string[] | null): string[] | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

function isAllowedByTags(
  serverTags: string[] | undefined,
  allowedTags: Set<string> | null,
): boolean {
  if (!allowedTags) return true;
  if (!serverTags || serverTags.length === 0) return false;
  return serverTags.some((t) => allowedTags.has(t));
}

export function authFromToken(
  cfg: NormalizedRouterConfig,
  token: string | null,
): AuthedPrincipal {
  const tokens = cfg.auth.tokens;
  if (tokens.length === 0) {
    return { enabled: false, token: null };
  }
  if (!token) {
    throw new Error('Missing token');
  }
  const match = tokens.find((t) => t.value === token);
  if (!match) {
    throw new Error('Invalid token');
  }

  const project = match.projectId ? cfg.projects[match.projectId] : null;
  const allowed = intersectAllowLists(project?.allowedMcpServers ?? null, match.allowedMcpServers ?? null);
  const allowedTags = intersectAllowLists(project?.allowedTags ?? null, match.allowedTags ?? null);
  const rateLimitRpm = match.rateLimitRpm ?? project?.rateLimitRpm ?? null;

  return {
    enabled: true,
    token,
    allowedMcpServers: allowed ? new Set(allowed) : null,
    allowedTags: allowedTags ? new Set(allowedTags) : null,
    rateLimitRpm,
    projectId: match.projectId ?? null,
  };
}

export function assertAllowedMcpServer(
  cfg: NormalizedRouterConfig,
  principal: AuthedPrincipal,
  serverName: string,
) {
  if (!principal.enabled) return;

  if (principal.allowedMcpServers && !principal.allowedMcpServers.has(serverName)) {
    throw new Error(`Token not allowed to access MCP server: ${serverName}`);
  }

  if (principal.allowedTags) {
    const server = cfg.mcpServers[serverName];
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    if (!isAllowedByTags(server.tags, principal.allowedTags)) {
      throw new Error(`Token not allowed to access MCP server by tags: ${serverName}`);
    }
  }
}

export function parseBearerOrApiKey(headers: Record<string, unknown>): string | null {
  const authorization = (headers['authorization'] ?? headers['Authorization']) as
    | string
    | undefined;
  if (authorization) {
    const m = authorization.match(/^Bearer\s+(.+)\s*$/i);
    if (m) return m[1] ?? null;
  }
  const apiKey = (headers['x-api-key'] ?? headers['X-API-Key']) as string | undefined;
  if (apiKey) return apiKey;
  return null;
}

// (assertAllowedMcpServer moved above to include tag policy)
