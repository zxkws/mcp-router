import type * as z from 'zod';

export type JsonObject = Record<string, unknown>;

export type RouterConfig = {
  listen?: {
    http?: { host?: string; port?: number; path?: string };
    stdio?: boolean;
  };
  auth?: {
    tokens?: Array<{
      value: string;
      allowedMcpServers?: string[];
    }>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  upstreams?: Record<string, McpServerConfig>; // legacy alias
};

export type McpServerConfig = {
  transport: 'streamable-http' | 'http';
  url: string;
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
    };

export type ToolListItem = {
  name: string;
  description?: string;
  inputSchema?: z.ZodTypeAny | unknown;
};

