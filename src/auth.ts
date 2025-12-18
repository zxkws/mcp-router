import type { AuthedPrincipal } from './types.js';
import type { NormalizedRouterConfig } from './config.js';

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
  return {
    enabled: true,
    token,
    allowedMcpServers: match.allowedMcpServers ? new Set(match.allowedMcpServers) : null,
  };
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

export function assertAllowedMcpServer(principal: AuthedPrincipal, serverName: string) {
  if (!principal.enabled) return;
  if (!principal.allowedMcpServers) return;
  if (!principal.allowedMcpServers.has(serverName)) {
    throw new Error(`Token not allowed to access MCP server: ${serverName}`);
  }
}

