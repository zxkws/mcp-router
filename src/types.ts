import type * as z from 'zod';

export type JsonObject = Record<string, unknown>;

export type RouterConfig = {
  listen?: {
    http?: { host?: string; port?: number; path?: string };
    stdio?: boolean;
  };
  admin?: {
    enabled?: boolean;
    path?: string;
    allowUnauthenticated?: boolean;
  };
  toolExposure?: 'hierarchical' | 'namespaced' | 'both';
  routing?: {
    selectorStrategy?: 'roundRobin' | 'random';
    healthChecks?: {
      enabled?: boolean;
      intervalMs?: number;
      timeoutMs?: number;
      includeStdio?: boolean;
    };
    circuitBreaker?: {
      enabled?: boolean;
      failureThreshold?: number;
      openMs?: number;
    };
  };
  audit?: {
    enabled?: boolean;
    logArguments?: boolean;
    maxArgumentChars?: number;
  };
  projects?: Array<{
    id: string;
    name?: string;
    allowedMcpServers?: string[];
    allowedTags?: string[];
    rateLimit?: { requestsPerMinute?: number };
  }>;
  sandbox?: {
    stdio?: {
      allowedCommands?: string[];
      allowedCwdRoots?: string[];
      allowedEnvKeys?: string[];
      inheritEnvKeys?: string[];
    };
  };
  auth?: {
    tokens?: Array<{
      value: string;
      projectId?: string;
      allowedMcpServers?: string[];
      allowedTags?: string[];
      rateLimit?: {
        requestsPerMinute?: number;
      };
    }>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  upstreams?: Record<string, McpServerConfig>; // legacy alias
};

export type McpServerConfig = {
  transport: 'streamable-http' | 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: 'inherit' | 'pipe';
  restart?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
  };
  enabled?: boolean;
  headers?: Record<string, string>;
  tags?: string[];
  version?: string;
  timeoutMs?: number;
};

export type AuthedPrincipal =
  | { enabled: false; token: null }
  | {
      enabled: true;
      token: string;
      allowedMcpServers: Set<string> | null; // null => allow all
      allowedTags: Set<string> | null;
      rateLimitRpm: number | null;
      projectId: string | null;
    };

export type ToolListItem = {
  name: string;
  description?: string;
  inputSchema?: z.ZodTypeAny | unknown;
};
