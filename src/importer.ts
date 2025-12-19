import path from 'node:path';
import * as toml from '@iarna/toml';
import type { McpServerConfig, RouterConfig } from './types.js';

export type ImportFormat =
  | 'auto'
  | 'router'
  | 'claude'
  | 'codex'
  | 'gemini'
  | '1mcp'
  | 'json';

export type ImportParseResult = {
  format: ImportFormat;
  servers: Record<string, McpServerConfig>;
  warnings: string[];
};

export type MergeOptions = {
  conflict?: 'skip' | 'overwrite' | 'rename';
  namePrefix?: string;
  addTags?: string[];
  enableByDefault?: boolean;
};

export type MergeResult = {
  added: string[];
  renamed: Array<{ from: string; to: string }>;
  skipped: Array<{ name: string; reason: string }>;
  deduped: Array<{ name: string; existing: string }>;
  overwritten: string[];
  warnings: string[];
};

type ParseOpts = {
  format?: ImportFormat;
  sourcePath?: string;
};

type StringRecord = Record<string, string>;

export function parseImportText(text: string, opts: ParseOpts = {}): ImportParseResult {
  const warnings: string[] = [];
  const formatHint = opts.format ?? 'auto';
  const sourcePath = opts.sourcePath;

  const tryToml = () => {
    try {
      return toml.parse(text);
    } catch (err) {
      warnings.push(`toml parse failed: ${(err as Error).message}`);
      return null;
    }
  };

  const tryJson = () => {
    try {
      return JSON.parse(text);
    } catch {
      const extracted = extractJsonSubstring(text);
      if (!extracted) return null;
      try {
        return JSON.parse(extracted);
      } catch {
        return null;
      }
    }
  };

  if (formatHint === 'codex' || looksLikeToml(text, sourcePath)) {
    const parsed = tryToml();
    if (parsed && typeof parsed === 'object') {
      return parseCodexToml(parsed as Record<string, unknown>, warnings);
    }
  }

  const json = tryJson();
  if (json && typeof json === 'object') {
    const detected = formatHint === 'auto' ? detectJsonFormat(json, sourcePath) : formatHint;
    if (detected === 'router') return parseRouterJson(json as RouterConfig, warnings);
    if (detected === '1mcp') return parseOneMcpJson(json as Record<string, unknown>, warnings);
    if (detected === 'gemini' || detected === 'claude' || detected === 'json') {
      return parseGenericJson(json as Record<string, unknown>, detected, warnings);
    }
    if (detected === 'codex') {
      warnings.push('format hint codex used with JSON input; falling back to generic JSON parser');
      return parseGenericJson(json as Record<string, unknown>, 'json', warnings);
    }
  }

  if (formatHint === 'codex') {
    const parsed = tryToml();
    if (parsed && typeof parsed === 'object') {
      return parseCodexToml(parsed as Record<string, unknown>, warnings);
    }
  }

  throw new Error('Unable to parse input as JSON or TOML');
}

export function mergeServers(
  existing: Record<string, McpServerConfig>,
  imported: Record<string, McpServerConfig>,
  opts: MergeOptions = {},
): { merged: Record<string, McpServerConfig>; result: MergeResult } {
  const conflict = opts.conflict ?? 'rename';
  const namePrefix = opts.namePrefix ?? '';
  const addTags = opts.addTags ?? [];
  const enableByDefault = opts.enableByDefault ?? true;

  const merged: Record<string, McpServerConfig> = { ...existing };
  const usedNames = new Set(Object.keys(merged));
  const fingerprintToName = new Map<string, string>();
  const result: MergeResult = {
    added: [],
    renamed: [],
    skipped: [],
    deduped: [],
    overwritten: [],
    warnings: [],
  };

  for (const [name, cfg] of Object.entries(existing)) {
    fingerprintToName.set(fingerprint(cfg), name);
  }

  for (const [rawName, rawCfg] of Object.entries(imported)) {
    const name = sanitizeName(`${namePrefix}${rawName}`);
    const cfg = cloneConfig(rawCfg);
    if (enableByDefault && cfg.enabled === undefined) cfg.enabled = true;
    if (addTags.length > 0) {
      const mergedTags = new Set([...(cfg.tags ?? []), ...addTags]);
      cfg.tags = Array.from(mergedTags);
    }

    const fp = fingerprint(cfg);
    const existingName = fingerprintToName.get(fp);
    if (existingName) {
      result.deduped.push({ name, existing: existingName });
      continue;
    }

    if (usedNames.has(name)) {
      if (conflict === 'skip') {
        result.skipped.push({ name, reason: 'name conflict' });
        continue;
      }
      if (conflict === 'overwrite') {
        merged[name] = cfg;
        fingerprintToName.set(fp, name);
        result.overwritten.push(name);
        continue;
      }
      const renamed = uniqueName(name, usedNames);
      merged[renamed] = cfg;
      usedNames.add(renamed);
      fingerprintToName.set(fp, renamed);
      result.renamed.push({ from: name, to: renamed });
      continue;
    }

    merged[name] = cfg;
    usedNames.add(name);
    fingerprintToName.set(fp, name);
    result.added.push(name);
  }

  return { merged, result };
}

function parseRouterJson(obj: RouterConfig, warnings: string[]): ImportParseResult {
  const servers = obj.mcpServers ?? obj.upstreams ?? {};
  return { format: 'router', servers: normalizeServerMap(servers, warnings), warnings };
}

function parseOneMcpJson(obj: Record<string, unknown>, warnings: string[]): ImportParseResult {
  const servers = extractServers(obj);
  if (!servers) throw new Error('No mcpServers found in 1mcp config');
  const normalized = normalizeServerMap(servers, warnings, { source: '1mcp' });
  return { format: '1mcp', servers: normalized, warnings };
}

function parseGenericJson(obj: Record<string, unknown>, format: ImportFormat, warnings: string[]): ImportParseResult {
  const servers = extractServers(obj);
  if (!servers) throw new Error('No mcpServers found in JSON config');
  const normalized = normalizeServerMap(servers, warnings, { source: format });
  return { format, servers: normalized, warnings };
}

function parseCodexToml(obj: Record<string, unknown>, warnings: string[]): ImportParseResult {
  const serversRaw = (obj.mcp_servers ?? obj.mcpServers) as Record<string, unknown> | undefined;
  if (!serversRaw || typeof serversRaw !== 'object') {
    throw new Error('No [mcp_servers] section found in TOML');
  }
  const normalized = normalizeServerMap(serversRaw, warnings, { source: 'codex' });
  return { format: 'codex', servers: normalized, warnings };
}

function detectJsonFormat(obj: unknown, sourcePath?: string): ImportFormat {
  const file = sourcePath ? path.basename(sourcePath).toLowerCase() : '';
  if (file.includes('claude') && file.endsWith('.json')) return 'claude';
  if (file.includes('gemini') && file.endsWith('.json')) return 'gemini';
  if (file.endsWith('.toml')) return 'codex';

  if (obj && typeof obj === 'object') {
    const asObj = obj as Record<string, unknown>;
    if (asObj.listen || asObj.toolExposure || asObj.routing || asObj.auth || asObj.projects) return 'router';
    const servers = extractServers(asObj);
    if (servers) {
      for (const value of Object.values(servers)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (v.connectionTimeout || v.requestTimeout || v.restartOnExit) return '1mcp';
        if (v.httpUrl || v.url) return 'gemini';
      }
      return 'json';
    }
  }
  return 'json';
}

function extractServers(obj: Record<string, unknown>): Record<string, unknown> | null {
  const direct = obj.mcpServers ?? obj.mcp_servers ?? obj.servers;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>;
  if (looksLikeServerConfig(obj)) return { imported: obj };
  return null;
}

function normalizeServerMap(
  raw: Record<string, unknown>,
  warnings: string[],
  opts?: { source?: ImportFormat },
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') {
      warnings.push(`skipped ${name}: invalid server config`);
      continue;
    }
    const parsed = normalizeServerConfig(name, value as Record<string, unknown>, warnings, opts?.source);
    if (!parsed) continue;
    result[parsed.name] = parsed.cfg;
  }
  return result;
}

function normalizeServerConfig(
  name: string,
  raw: Record<string, unknown>,
  warnings: string[],
  source?: ImportFormat,
): { name: string; cfg: McpServerConfig } | null {
  const normalizedName = sanitizeName(name);
  if (normalizedName !== name) {
    warnings.push(`normalized server name "${name}" -> "${normalizedName}"`);
  }

  const transport = inferTransport(raw);
  if (!transport) {
    warnings.push(`skipped ${name}: unable to infer transport`);
    return null;
  }

  const cfg: McpServerConfig = { transport };
  const enabled = coerceEnabled(raw);
  if (enabled !== undefined) cfg.enabled = enabled;

  const tags = coerceStringArray(raw.tags ?? raw.tag);
  if (tags.length > 0) cfg.tags = tags;

  const version = typeof raw.version === 'string' ? raw.version : undefined;
  if (version) cfg.version = version;

  const timeoutMs = coerceTimeoutMs(raw);
  if (timeoutMs) cfg.timeoutMs = timeoutMs;

  if (transport === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command : undefined;
    if (!command) {
      warnings.push(`skipped ${name}: stdio transport without command`);
      return null;
    }
    cfg.command = command;
    const args = coerceStringArray(raw.args);
    if (args.length > 0) cfg.args = args;
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
    if (cwd) cfg.cwd = cwd;
    const env = coerceStringRecord(raw.env);
    if (Object.keys(env).length > 0) cfg.env = env;
    if (raw.stderr === 'inherit' || raw.stderr === 'pipe') cfg.stderr = raw.stderr;
  } else {
    const url = coerceUrl(raw);
    if (!url) {
      warnings.push(`skipped ${name}: http transport without url`);
      return null;
    }
    cfg.url = url;
    const headers = {
      ...coerceStringRecord(raw.headers),
      ...coerceStringRecord(raw.http_headers),
      ...coerceStringRecord(raw.httpHeaders),
    };
    if (Object.keys(headers).length > 0) cfg.headers = headers;

    if (raw.env_http_headers || raw.envHttpHeaders) {
      warnings.push(`server "${name}" uses env_http_headers; set headers manually in mcp-router`);
    }

    if (source === 'codex') {
      const bearerEnv = typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : null;
      if (bearerEnv) {
        warnings.push(`codex server "${name}" uses bearer_token_env_var (${bearerEnv}); set headers.Authorization manually`);
      }
    }
  }

  return { name: normalizedName, cfg };
}

function inferTransport(raw: Record<string, unknown>): McpServerConfig['transport'] | null {
  const transport = typeof raw.transport === 'string' ? raw.transport : null;
  const type = typeof raw.type === 'string' ? raw.type : null;

  const resolved = (transport ?? type ?? '').toLowerCase().replace(/_/g, '-');
  if (resolved === 'stdio') return 'stdio';
  if (resolved === 'streamable-http') return 'streamable-http';
  if (resolved === 'http' || resolved === 'sse') return 'http';

  if (raw.httpUrl || raw.http_url || raw.url || raw.endpoint) return 'streamable-http';
  if (raw.command || raw.args) return 'stdio';
  return null;
}

function coerceEnabled(raw: Record<string, unknown>): boolean | undefined {
  if (typeof raw.enabled === 'boolean') return raw.enabled;
  if (typeof raw.disabled === 'boolean') return !raw.disabled;
  return undefined;
}

function coerceUrl(raw: Record<string, unknown>): string | null {
  const url =
    (typeof raw.httpUrl === 'string' ? raw.httpUrl : null) ??
    (typeof raw.http_url === 'string' ? raw.http_url : null) ??
    (typeof raw.url === 'string' ? raw.url : null) ??
    (typeof raw.endpoint === 'string' ? raw.endpoint : null);
  return url ? url.trim() : null;
}

function coerceTimeoutMs(raw: Record<string, unknown>): number | null {
  const candidate =
    (typeof raw.timeoutMs === 'number' ? raw.timeoutMs : null) ??
    (typeof raw.timeout === 'number' ? raw.timeout : null) ??
    (typeof raw.requestTimeout === 'number' ? raw.requestTimeout : null) ??
    (typeof raw.tool_timeout_ms === 'number' ? raw.tool_timeout_ms : null) ??
    (typeof raw.tool_timeout_sec === 'number' ? raw.tool_timeout_sec * 1000 : null) ??
    (typeof raw.startup_timeout_ms === 'number' ? raw.startup_timeout_ms : null);
  if (candidate && Number.isFinite(candidate) && candidate > 0) return Math.round(candidate);
  return null;
}

function coerceStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string') as string[];
  if (typeof value === 'string') {
    const parts = value
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : [value];
  }
  return [];
}

function coerceStringRecord(value: unknown): StringRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: StringRecord = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}

function looksLikeServerConfig(obj: Record<string, unknown>): boolean {
  return Boolean(obj.command || obj.args || obj.url || obj.httpUrl || obj.transport);
}

function looksLikeToml(text: string, sourcePath?: string): boolean {
  if (sourcePath && sourcePath.toLowerCase().endsWith('.toml')) return true;
  return /\[\s*mcp_servers\s*\]/i.test(text) || /\[\s*mcp_servers\.[^\]]+\]/i.test(text);
}

function extractJsonSubstring(text: string): string | null {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) return text.slice(firstArr, lastArr + 1);
  return null;
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'imported';
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function normalizeUrl(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url.trim());
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    u.hash = '';
    return u.toString();
  } catch {
    return url.trim();
  }
}

function fingerprint(cfg: McpServerConfig): string {
  const core = {
    transport: cfg.transport,
    url: normalizeUrl(cfg.url),
    command: cfg.command ?? '',
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? '',
    env: sortRecord(cfg.env ?? {}),
    headers: sortRecord(cfg.headers ?? {}),
  };
  return stableStringify(core);
}

function sortRecord(obj: StringRecord): StringRecord {
  const sorted: StringRecord = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneConfig(cfg: McpServerConfig): McpServerConfig {
  return {
    transport: cfg.transport,
    url: cfg.url,
    command: cfg.command,
    args: cfg.args ? [...cfg.args] : undefined,
    cwd: cfg.cwd,
    env: cfg.env ? { ...cfg.env } : undefined,
    stderr: cfg.stderr,
    restart: cfg.restart ? { ...cfg.restart } : undefined,
    enabled: cfg.enabled,
    headers: cfg.headers ? { ...cfg.headers } : undefined,
    tags: cfg.tags ? [...cfg.tags] : undefined,
    version: cfg.version,
    timeoutMs: cfg.timeoutMs,
  };
}
