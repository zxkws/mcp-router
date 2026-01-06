#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfigFile, defaultConfigPath, watchConfigFile, parseRouterConfig } from './config.js';
import { createLogger } from './log.js';
import { UpstreamManager } from './upstream/manager.js';
import { startHttpServer } from './httpServer.js';
import { startStdioServer } from './stdioServer.js';
import { mergeServers, parseImportText, type ImportFormat } from './importer.js';

function argValue(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function collectArgs(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function parseBoolean(value: string | null): boolean | null {
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false;
  return null;
}

function parseKeyValuePairs(values: string[], label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values) {
    const idx = item.indexOf('=');
    if (idx <= 0) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-router] ignored ${label}: ${item} (expected KEY=VALUE)`);
      continue;
    }
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1);
    if (!key) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-router] ignored ${label}: ${item} (empty key)`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function normalizeFormat(value: string | null): ImportFormat {
  const allowed: ImportFormat[] = ['auto', 'router', 'claude', 'codex', 'gemini', '1mcp', 'json'];
  if (!value) return 'auto';
  const lowered = value.toLowerCase() as ImportFormat;
  return allowed.includes(lowered) ? lowered : 'auto';
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function usage(exitCode = 0) {
  // eslint-disable-next-line no-console
  console.log(
    [
      'mcp-router (mcpr)',
      '',
      'Usage:',
      '  mcpr init   [--config ./mcp-router.config.json] [--force]',
      '  mcpr add    --config ./mcp-router.config.json --name <name> [--transport http|streamable-http|stdio] [--url <url>] [--command <cmd>] [--arg <arg>] [--cwd <cwd>] [--env KEY=VAL] [--header KEY=VAL] [--tag tag] [--version <v>] [--timeout-ms <ms>] [--enabled true|false] [--overwrite]',
      '  mcpr list   --config ./mcp-router.config.json [--json]',
      '  mcpr status --config ./mcp-router.config.json [--json] [--include-stdio] [--timeout-ms <ms>]',
      '  mcpr import --config ./mcp-router.config.json --from <file|-> [--format auto|claude|codex|gemini|1mcp|router|json] [--conflict rename|skip|overwrite] [--prefix name-] [--tag tag] [--dry-run]',
      '  mcpr serve  --config ./mcp-router.config.json [--host 127.0.0.1] [--port 8080] [--path /mcp] [--no-watch]',
      '  mcpr stdio  --config ./mcp-router.config.json --token <TOKEN> [--no-watch]',
      '  mcpr run    [--port 8080] [--env KEY=VAL]... [--cwd path] -- <command> [args...]',
      '  mcpr validate --config ./mcp-router.config.json',
      '  mcpr print-config --config ./mcp-router.config.json',
      '',
      'Notes:',
      '  - If auth.tokens is empty, auth is disabled (no token needed).',
      '  - If the HTTP port is in use, change listen.http.port or pass --port (or set it to 0 for auto).',
    ].join('\n'),
  );
  process.exit(exitCode);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help') usage(0);

  if (cmd === 'run') {
    let command: string;
    let cmdArgs: string[];
    let portArg: string | null = null;
    let hostArg: string | null = null;
    let transportArg: string | null = null;
    let cwdArg: string | null = null;
    let envPairs: Record<string, string> = {};

    // Run mode
    let runArgs = args.slice(1);
    const commandStartIdx = runArgs.indexOf('--');
    let commandParts: string[] = [];
    let flags: string[] = [];

    if (commandStartIdx !== -1) {
      flags = runArgs.slice(0, commandStartIdx);
      commandParts = runArgs.slice(commandStartIdx + 1);
    } else {
      const knownFlags = ['--port', '--host', '--transport', '--env', '--cwd', '--debug'];
      const firstArg = runArgs[0];
      if (firstArg && !knownFlags.includes(firstArg) && !firstArg.startsWith('--port=')) {
          commandParts = runArgs;
          flags = [];
      } else {
           // eslint-disable-next-line no-console
          console.error('[mcp-router] error: Use "--" to separate router flags from command. Example: mcpr run --port 8080 -- npx server');
          process.exit(1);
      }
    }

    if (commandParts.length === 0) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] run requires a command. Example: mcpr run -- npx -y server');
      process.exit(1);
    }

    portArg = argValue(flags, '--port');
    hostArg = argValue(flags, '--host');
    transportArg = argValue(flags, '--transport');
    cwdArg = argValue(flags, '--cwd');
    envPairs = parseKeyValuePairs(collectArgs(flags, '--env'), 'env');
    command = commandParts[0];
    cmdArgs = commandParts.slice(1);

    const port = portArg ? Number(portArg) : 8080;
    const host = hostArg ?? '127.0.0.1';
    
    // Logic for mode selection
    let mode = 'stdio';
    if (portArg || transportArg === 'http') mode = 'http';
    if (transportArg === 'stdio') mode = 'stdio';

    const syntheticConfig: any = {
      configPath: 'synthetic',
      listen: {
        http: mode === 'http' ? { host, port, path: '/mcp' } : null,
        stdio: mode === 'stdio',
      },
      admin: { enabled: false, path: '/admin', allowUnauthenticated: false },
      toolExposure: 'hierarchical',
      routing: {
        selectorStrategy: 'roundRobin',
        healthChecks: { enabled: true, intervalMs: 15000, timeoutMs: 5000, includeStdio: false },
        circuitBreaker: { enabled: true, failureThreshold: 3, openMs: 30000 },
      },
      audit: { enabled: true, logArguments: false, maxArgumentChars: 2000 },
      projects: {},
      sandbox: { stdio: { allowedCommands: null, allowedCwdRoots: null, allowedEnvKeys: null, inheritEnvKeys: null } },
      auth: { tokens: [] },
      mcpServers: {
        default: {
          transport: 'stdio',
          command,
          args: cmdArgs,
          cwd: cwdArg,
          env: envPairs,
          enabled: true,
        }
      }
    };

    const logger = createLogger();
    const upstreams = new UpstreamManager({ logger });
    // @ts-ignore - simplified config ref
    upstreams.setConfigRef({ current: syntheticConfig });

    if (mode === 'http') {
       const targetDesc = `${command} ${cmdArgs.join(' ')}`;
       // eslint-disable-next-line no-console
       console.error(`[mcp-router] Running in HTTP mode on ${host}:${port}, proxying to: ${targetDesc}`);
       await startHttpServer({ configRef: { current: syntheticConfig }, upstreams, logger, host, port, path: '/mcp' });
    } else {
       const targetDesc = `${command} ${cmdArgs.join(' ')}`;
       // eslint-disable-next-line no-console
       console.error(`[mcp-router] Running in stdio mode, proxying to: ${targetDesc}`);
       await startStdioServer({ configRef: { current: syntheticConfig }, upstreams, logger, token: null });
    }
    return;
  }

  if (cmd === 'init') {
    const cfgPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
    const force = hasFlag(args, '--force');
    const template = {
      listen: { http: { port: 8080, path: '/mcp' }, stdio: true },
      toolExposure: 'hierarchical',
      routing: {
        selectorStrategy: 'roundRobin',
        healthChecks: { enabled: true, intervalMs: 15000, timeoutMs: 5000, includeStdio: false },
        circuitBreaker: { enabled: true, failureThreshold: 3, openMs: 30000 },
      },
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'npx',
          args: [
            '-y',
            '@modelcontextprotocol/server-filesystem',
            '/Users/username/Desktop',
          ],
          enabled: false,
        },
      },
    };

    try {
      if (!force) {
        // Check if file exists
        try {
          await fs.access(cfgPath);
          // If we are here, it exists
          // eslint-disable-next-line no-console
          console.error(`[mcp-router] config already exists: ${cfgPath} (use --force to overwrite)`);
          process.exit(1);
        } catch {
          // Doesn't exist, proceed
        }
      }
    } catch {
      // ok
    }

    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[mcp-router] wrote ${cfgPath}`);
    // eslint-disable-next-line no-console
    console.log('Next: npx mcpr serve');
    return;
  }

  if (cmd === 'import') {
    const cfgPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
    const from = argValue(args, '--from') ?? argValue(args, '--input');
    const format = normalizeFormat(argValue(args, '--format'));
    const conflictRaw = argValue(args, '--conflict') ?? 'rename';
    const conflict =
      conflictRaw === 'skip' || conflictRaw === 'overwrite' || conflictRaw === 'rename'
        ? conflictRaw
        : 'rename';
    const prefix = argValue(args, '--prefix') ?? '';
    const dryRun = hasFlag(args, '--dry-run');
    const tagArgs = collectArgs(args, '--tag');
    const tags = tagArgs
      .flatMap((t) => t.split(/[,\s]+/))
      .map((t) => t.trim())
      .filter(Boolean);

    if (!from) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] import requires --from <file|->');
      process.exit(1);
    }

    const importText = from === '-' ? await readStdin() : await fs.readFile(from, 'utf8');
    const parsed = parseImportText(importText, { format, sourcePath: from === '-' ? undefined : from });

    const rawText = await fs.readFile(cfgPath, 'utf8');
    const rawJson = JSON.parse(rawText);
    const rawConfig = parseRouterConfig(rawJson);
    const targetKey = rawConfig.mcpServers
      ? 'mcpServers'
      : rawConfig.upstreams
        ? 'upstreams'
        : 'mcpServers';
    const existing = (rawConfig as any)[targetKey] ?? {};
    const { merged, result } = mergeServers(existing, parsed.servers, {
      conflict,
      namePrefix: prefix,
      addTags: tags,
    });
    const updated: any = { ...rawConfig, [targetKey]: merged };
    if (targetKey === 'mcpServers') delete updated.upstreams;
    parseRouterConfig(updated);

    // eslint-disable-next-line no-console
    console.log(
      `[mcp-router] import format=${parsed.format} existing=${Object.keys(existing).length} merged=${Object.keys(merged).length} added=${result.added.length} renamed=${result.renamed.length} overwritten=${result.overwritten.length} deduped=${result.deduped.length} skipped=${result.skipped.length}`,
    );
    if (parsed.warnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-router] warnings:\\n- ${parsed.warnings.join('\\n- ')}`);
    }

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log('[mcp-router] dry-run: no changes written');
      return;
    }

    await fs.writeFile(cfgPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[mcp-router] updated ${cfgPath}`);
    return;
  }

  if (cmd === 'add') {
    const cfgPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
    const nameRaw = argValue(args, '--name');
    if (!nameRaw) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] add requires --name');
      process.exit(1);
    }
    const name = nameRaw.trim();
    const transportArg = argValue(args, '--transport');
    const url = argValue(args, '--url');
    const command = argValue(args, '--command');
    const cwd = argValue(args, '--cwd');
    const argsList = collectArgs(args, '--arg');
    const envPairs = parseKeyValuePairs(collectArgs(args, '--env'), 'env');
    const headerPairs = parseKeyValuePairs(collectArgs(args, '--header'), 'header');
    const tags = collectArgs(args, '--tag').filter(Boolean);
    const version = argValue(args, '--version');
    const timeoutMsRaw = argValue(args, '--timeout-ms');
    const enabledRaw = argValue(args, '--enabled');
    const disabledFlag = hasFlag(args, '--disabled');
    const overwrite = hasFlag(args, '--overwrite');

    const enabledParsed = parseBoolean(enabledRaw);
    const enabled = enabledParsed !== null ? enabledParsed : disabledFlag ? false : undefined;

    let transport: 'http' | 'streamable-http' | 'stdio' | null = null;
    if (transportArg) {
      const lowered = transportArg.toLowerCase();
      if (lowered === 'http' || lowered === 'streamable-http' || lowered === 'stdio') transport = lowered;
    }
    if (!transport) {
      if (url) transport = 'streamable-http';
      else if (command) transport = 'stdio';
    }

    if (!transport) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] add requires --transport or --url/--command');
      process.exit(1);
    }

    if ((transport === 'http' || transport === 'streamable-http') && !url) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] add requires --url for http/streamable-http');
      process.exit(1);
    }
    if (transport === 'stdio' && !command) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] add requires --command for stdio');
      process.exit(1);
    }

    const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : null;
    if (timeoutMsRaw && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] invalid --timeout-ms');
      process.exit(1);
    }

    const rawText = await fs.readFile(cfgPath, 'utf8');
    const rawJson = JSON.parse(rawText);
    const rawConfig = parseRouterConfig(rawJson);
    const targetKey = rawConfig.mcpServers
      ? 'mcpServers'
      : rawConfig.upstreams
        ? 'upstreams'
        : 'mcpServers';
    const existing = (rawConfig as any)[targetKey] ?? {};
    if (existing[name] && !overwrite) {
      // eslint-disable-next-line no-console
      console.error(`[mcp-router] server "${name}" already exists (use --overwrite)`);
      process.exit(1);
    }

    const cfg: any = { transport };
    if (url) cfg.url = url;
    if (command) cfg.command = command;
    if (argsList.length > 0) cfg.args = argsList;
    if (cwd) cfg.cwd = cwd;
    if (Object.keys(envPairs).length > 0) cfg.env = envPairs;
    if (Object.keys(headerPairs).length > 0) cfg.headers = headerPairs;
    if (tags.length > 0) cfg.tags = tags;
    if (version) cfg.version = version;
    if (timeoutMs) cfg.timeoutMs = timeoutMs;
    if (enabled !== undefined) cfg.enabled = enabled;

    const updated: any = { ...rawConfig, [targetKey]: { ...existing, [name]: cfg } };
    if (targetKey === 'mcpServers') delete updated.upstreams;
    parseRouterConfig(updated);

    await fs.writeFile(cfgPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[mcp-router] added ${name} (${transport}) to ${cfgPath}`);
    return;
  }

  if (cmd === 'list') {
    const cfgPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
    const jsonOut = hasFlag(args, '--json');
    const cfg = loadConfigFile(cfgPath);
    const entries = Object.entries(cfg.mcpServers);
    if (jsonOut) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(entries.map(([name, s]) => ({ name, ...s })), null, 2));
      return;
    }
    for (const [name, s] of entries) {
      const target = s.transport === 'stdio' ? s.command ?? '' : s.url ?? '';
      const tags = s.tags && s.tags.length > 0 ? ` tags=${s.tags.join(',')}` : '';
      const version = s.version ? ` version=${s.version}` : '';
      const enabled = s.enabled ? 'enabled' : 'disabled';
      // eslint-disable-next-line no-console
      console.log(`${name}\t${s.transport}\t${enabled}\t${target}${tags}${version}`);
    }
    return;
  }

  if (cmd === 'status') {
    const cfgPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
    const jsonOut = hasFlag(args, '--json');
    const includeStdio = hasFlag(args, '--include-stdio');
    const timeoutMsRaw = argValue(args, '--timeout-ms');
    const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : null;
    if (timeoutMsRaw && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router] invalid --timeout-ms');
      process.exit(1);
    }

    const logger = createLogger();
    const upstreams = new UpstreamManager({ logger });
    const configRef = { current: loadConfigFile(cfgPath) };
    upstreams.setConfigRef(configRef);

    if (timeoutMs) {
      for (const cfg of Object.values(configRef.current.mcpServers)) {
        if (!cfg.timeoutMs) cfg.timeoutMs = timeoutMs;
      }
    }

    const results: Array<{ name: string; status: string; detail?: string }> = [];
    let hasError = false;
    for (const [name, cfg] of Object.entries(configRef.current.mcpServers)) {
      if (!cfg.enabled) {
        results.push({ name, status: 'disabled' });
        continue;
      }
      if (cfg.transport === 'stdio' && !includeStdio) {
        results.push({ name, status: 'skipped-stdio' });
        continue;
      }
      try {
        const client = upstreams.getClient(name, cfg);
        const res = await client.listTools();
        const count = Array.isArray((res as any).tools) ? (res as any).tools.length : 0;
        results.push({ name, status: 'ok', detail: `tools=${count}` });
      } catch (err) {
        hasError = true;
        results.push({ name, status: 'error', detail: (err as Error).message });
      }
    }

    await upstreams.closeAll();

    if (jsonOut) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const item of results) {
        const detail = item.detail ? `\t${item.detail}` : '';
        // eslint-disable-next-line no-console
        console.log(`${item.name}\t${item.status}${detail}`);
      }
    }
    process.exitCode = hasError ? 1 : 0;
    return;
  }

  const logger = createLogger();
  const upstreams = new UpstreamManager({ logger });

  const configPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
  let config;
  try {
    config = loadConfigFile(configPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-router] Config not found at ${configPath}. Initializing default config...`);

      const template = {
        listen: { http: { port: 8080, path: '/mcp' }, stdio: true },
        toolExposure: 'hierarchical',
        routing: {
          selectorStrategy: 'roundRobin',
          healthChecks: { enabled: true, intervalMs: 15000, timeoutMs: 5000, includeStdio: false },
          circuitBreaker: { enabled: true, failureThreshold: 3, openMs: 30000 },
        },
        mcpServers: {
          filesystem: {
            transport: 'stdio',
            command: 'npx',
            args: [
              '-y',
              '@modelcontextprotocol/server-filesystem',
              '/Users/username/Desktop',
            ],
            enabled: false,
          },
        },
      };

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

      config = loadConfigFile(configPath);
    } else {
      throw err;
    }
  }
  const configRef = { current: config };

  upstreams.setConfigRef(configRef);

  const isLongRunning = cmd === 'serve' || cmd === 'stdio';
  const watch = isLongRunning && !hasFlag(args, '--no-watch');
  const stopWatch = watch
    ? watchConfigFile(configPath, (c) => {
        configRef.current = c;
        upstreams.onConfigUpdate(c);
      })
    : null;

  if (isLongRunning) {
    const shutdown = async () => {
      stopWatch?.();
      await upstreams.closeAll();
    };
    process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
    process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  }

  if (cmd === 'serve') {
    const host = argValue(args, '--host') ?? configRef.current.listen.http?.host ?? '127.0.0.1';
    const portArg = argValue(args, '--port');
    const envPort = process.env.PORT ? Number(process.env.PORT) : null;
    const port = portArg
      ? Number(portArg)
      : configRef.current.listen.http?.port ?? envPort ?? 8080;
    const mcpPath = argValue(args, '--path') ?? configRef.current.listen.http?.path ?? '/mcp';
    await startHttpServer({ configRef, upstreams, logger, host, port, path: mcpPath });
    return;
  }

  if (cmd === 'stdio') {
    const token = argValue(args, '--token');
    await startStdioServer({ configRef, upstreams, logger, token });
    return;
  }

  if (cmd === 'print-config') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(configRef.current, null, 2));
    stopWatch?.();
    return;
  }

  if (cmd === 'validate') {
    // If we got here, loadConfigFile already succeeded.
    // eslint-disable-next-line no-console
    console.log('OK');
    stopWatch?.();
    return;
  }

  usage(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[mcp-router] fatal: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
