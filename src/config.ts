import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { McpServerConfig, RouterConfig } from './types.js';

const HttpLikeUpstreamSchemaBase = z
  .object({
    url: z.string().url(),
    enabled: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const McpServerConfigSchema = z.discriminatedUnion('transport', [
  HttpLikeUpstreamSchemaBase.extend({ transport: z.literal('streamable-http') }),
  HttpLikeUpstreamSchemaBase.extend({ transport: z.literal('http') }),
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      stderr: z.union([z.literal('inherit'), z.literal('pipe')]).optional(),
      restart: z
        .object({
          maxRetries: z.number().int().min(0).optional(),
          initialDelayMs: z.number().int().min(0).optional(),
          maxDelayMs: z.number().int().min(0).optional(),
          factor: z.number().positive().optional(),
        })
        .optional(),
      enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      version: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]) satisfies z.ZodType<McpServerConfig>;

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
  admin: z
    .object({
      enabled: z.boolean().optional(),
      path: z.string().optional(),
      allowUnauthenticated: z.boolean().optional(),
    })
    .optional(),
  toolExposure: z.union([z.literal('hierarchical'), z.literal('namespaced'), z.literal('both')]).optional(),
  routing: z
    .object({
      selectorStrategy: z.union([z.literal('roundRobin'), z.literal('random')]).optional(),
      healthChecks: z
        .object({
          enabled: z.boolean().optional(),
          intervalMs: z.number().int().positive().optional(),
          timeoutMs: z.number().int().positive().optional(),
          includeStdio: z.boolean().optional(),
        })
        .optional(),
      circuitBreaker: z
        .object({
          enabled: z.boolean().optional(),
          failureThreshold: z.number().int().positive().optional(),
          openMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  audit: z
    .object({
      enabled: z.boolean().optional(),
      logArguments: z.boolean().optional(),
      maxArgumentChars: z.number().int().positive().optional(),
    })
    .optional(),
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        allowedMcpServers: z.array(z.string()).optional(),
        allowedTags: z.array(z.string()).optional(),
        rateLimit: z
          .object({
            requestsPerMinute: z.number().int().positive().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  sandbox: z
    .object({
      stdio: z
        .object({
          allowedCommands: z.array(z.string()).optional(),
          allowedCwdRoots: z.array(z.string()).optional(),
          allowedEnvKeys: z.array(z.string()).optional(),
          inheritEnvKeys: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  auth: z
    .object({
      tokens: z
        .array(
          z.object({
            value: z.string().min(1),
            projectId: z.string().min(1).optional(),
            allowedMcpServers: z.array(z.string()).optional(),
            allowedTags: z.array(z.string()).optional(),
            rateLimit: z
              .object({
                requestsPerMinute: z.number().int().positive().optional(),
              })
              .optional(),
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
  admin: {
    enabled: boolean;
    path: string;
    allowUnauthenticated: boolean;
  };
  toolExposure: 'hierarchical' | 'namespaced' | 'both';
  routing: {
    selectorStrategy: 'roundRobin' | 'random';
    healthChecks: {
      enabled: boolean;
      intervalMs: number;
      timeoutMs: number;
      includeStdio: boolean;
    };
    circuitBreaker: {
      enabled: boolean;
      failureThreshold: number;
      openMs: number;
    };
  };
  audit: {
    enabled: boolean;
    logArguments: boolean;
    maxArgumentChars: number;
  };
  projects: Record<
    string,
    {
      id: string;
      name: string | null;
      allowedMcpServers: string[] | null;
      allowedTags: string[] | null;
      rateLimitRpm: number | null;
    }
  >;
  sandbox: {
    stdio: {
      allowedCommands: string[] | null;
      allowedCwdRoots: string[] | null;
      allowedEnvKeys: string[] | null;
      inheritEnvKeys: string[] | null;
    };
  };
  auth: {
    tokens: Array<{
      value: string;
      projectId: string | null;
      allowedMcpServers: string[] | null;
      allowedTags: string[] | null;
      rateLimitRpm: number | null;
    }>;
  };
  mcpServers: Record<string, McpServerConfig & { enabled: boolean }>;
};

export function defaultConfigPath(cwd = process.cwd()) {
  const local = path.join(cwd, 'mcp-router.config.json');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), '.mcpr', 'mcp-router.config.json');
}

export function parseRouterConfig(input: unknown): RouterConfig {
  return RouterConfigSchema.parse(input);
}

export function loadConfigFile(configPath: string): NormalizedRouterConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseRouterConfig(JSON.parse(raw));
  const mcpServers = parsed.mcpServers ?? parsed.upstreams ?? {};
  const normalizedServers: NormalizedRouterConfig['mcpServers'] = {};

  for (const [name, cfg] of Object.entries(mcpServers)) {
    normalizedServers[name] = { ...cfg, enabled: cfg.enabled ?? true };
  }

  const projects: NormalizedRouterConfig['projects'] = {};
  for (const p of parsed.projects ?? []) {
    projects[p.id] = {
      id: p.id,
      name: p.name ?? null,
      allowedMcpServers: p.allowedMcpServers ?? null,
      allowedTags: p.allowedTags ?? null,
      rateLimitRpm: p.rateLimit?.requestsPerMinute ?? null,
    };
  }

  // Validate token.projectId references if provided
  for (const t of parsed.auth?.tokens ?? []) {
    if (t.projectId && !projects[t.projectId]) {
      throw new Error(`Unknown projectId referenced by token: ${t.projectId}`);
    }
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
    admin: {
      enabled: parsed.admin?.enabled ?? false,
      path: parsed.admin?.path ?? '/admin',
      allowUnauthenticated: parsed.admin?.allowUnauthenticated ?? false,
    },
    toolExposure: parsed.toolExposure ?? 'hierarchical',
    routing: {
      selectorStrategy: parsed.routing?.selectorStrategy ?? 'roundRobin',
      healthChecks: {
        enabled: parsed.routing?.healthChecks?.enabled ?? true,
        intervalMs: parsed.routing?.healthChecks?.intervalMs ?? 15_000,
        timeoutMs: parsed.routing?.healthChecks?.timeoutMs ?? 5_000,
        includeStdio: parsed.routing?.healthChecks?.includeStdio ?? false,
      },
      circuitBreaker: {
        enabled: parsed.routing?.circuitBreaker?.enabled ?? true,
        failureThreshold: parsed.routing?.circuitBreaker?.failureThreshold ?? 3,
        openMs: parsed.routing?.circuitBreaker?.openMs ?? 30_000,
      },
    },
    audit: {
      enabled: parsed.audit?.enabled ?? true,
      logArguments: parsed.audit?.logArguments ?? false,
      maxArgumentChars: parsed.audit?.maxArgumentChars ?? 2000,
    },
    projects,
    sandbox: {
      stdio: {
        allowedCommands: parsed.sandbox?.stdio?.allowedCommands ?? null,
        allowedCwdRoots: parsed.sandbox?.stdio?.allowedCwdRoots ?? null,
        allowedEnvKeys: parsed.sandbox?.stdio?.allowedEnvKeys ?? null,
        inheritEnvKeys: parsed.sandbox?.stdio?.inheritEnvKeys ?? null,
      },
    },
    auth: {
      tokens:
        parsed.auth?.tokens?.map((t) => ({
          value: t.value,
          projectId: t.projectId ?? null,
          allowedMcpServers: t.allowedMcpServers ?? null,
          allowedTags: t.allowedTags ?? null,
          rateLimitRpm: t.rateLimit?.requestsPerMinute ?? null,
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
