import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerConfig, RouterConfig } from './types.js';

const McpServerConfigSchema = z.object({
  transport: z.union([z.literal('streamable-http'), z.literal('http')]),
  url: z.string().url(),
  enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}) satisfies z.ZodType<McpServerConfig>;

const RouterConfigSchema = z.object({
  listen: z
    .object({
      http: z
        .object({
          host: z.string().optional(),
          port: z.number().int().min(0).max(65535).optional(),
          path: z.string().optional(),
        })
        .optional(),
      stdio: z.boolean().optional(),
    })
    .optional(),
  auth: z
    .object({
      tokens: z
        .array(
          z.object({
            value: z.string().min(1),
            allowedMcpServers: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  upstreams: z.record(z.string(), McpServerConfigSchema).optional(),
}) satisfies z.ZodType<RouterConfig>;

export type NormalizedRouterConfig = {
  configPath: string;
  listen: {
    http: { host: string; port: number; path: string } | null;
    stdio: boolean;
  };
  auth: {
    tokens: Array<{ value: string; allowedMcpServers: string[] | null }>;
  };
  mcpServers: Record<string, McpServerConfig & { enabled: boolean }>;
};

export function defaultConfigPath(cwd = process.cwd()) {
  return path.join(cwd, 'mcp-router.config.json');
}

export function loadConfigFile(configPath: string): NormalizedRouterConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = RouterConfigSchema.parse(JSON.parse(raw));
  const mcpServers = parsed.mcpServers ?? parsed.upstreams ?? {};
  const normalizedServers: NormalizedRouterConfig['mcpServers'] = {};

  for (const [name, cfg] of Object.entries(mcpServers)) {
    normalizedServers[name] = { ...cfg, enabled: cfg.enabled ?? true };
  }

  const http = parsed.listen?.http
    ? {
        host: parsed.listen.http.host ?? '127.0.0.1',
        port: parsed.listen.http.port ?? 8080,
        path: parsed.listen.http.path ?? '/mcp',
      }
    : null;

  return {
    configPath,
    listen: {
      http,
      stdio: parsed.listen?.stdio ?? true,
    },
    auth: {
      tokens:
        parsed.auth?.tokens?.map((t) => ({
          value: t.value,
          allowedMcpServers: t.allowedMcpServers ?? null,
        })) ?? [],
    },
    mcpServers: normalizedServers,
  };
}

export function watchConfigFile(
  configPath: string,
  onChange: (cfg: NormalizedRouterConfig) => void,
) {
  let timer: NodeJS.Timeout | null = null;

  const reload = () => {
    try {
      const cfg = loadConfigFile(configPath);
      onChange(cfg);
    } catch (err) {
      // Keep last good config if reload fails.
      // eslint-disable-next-line no-console
      console.error(`[mcp-router] config reload failed: ${(err as Error).message}`);
    }
  };

  const watcher = fs.watch(configPath, { persistent: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 75);
  });

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

