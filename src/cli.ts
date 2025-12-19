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
      '  mcpr import --config ./mcp-router.config.json --from <file|-> [--format auto|claude|codex|gemini|1mcp|router|json] [--conflict rename|skip|overwrite] [--prefix name-] [--tag tag] [--dry-run]',
      '  mcpr serve  --config ./mcp-router.config.json [--host 127.0.0.1] [--port 8080] [--path /mcp] [--no-watch]',
      '  mcpr stdio  --config ./mcp-router.config.json --token <TOKEN> [--no-watch]',
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
      auth: { tokens: [{ value: 'dev-token' }] },
      mcpServers: {
        demo: {
          transport: 'streamable-http',
          url: 'http://127.0.0.1:9001/mcp',
          enabled: true,
          tags: ['demo'],
          version: '1.0.0',
          headers: { Authorization: 'Bearer upstream-token-if-needed' },
        },
      },
    };

    try {
      if (!force) {
        await fs.access(cfgPath);
        // eslint-disable-next-line no-console
        console.error(`[mcp-router] config already exists: ${cfgPath} (use --force to overwrite)`);
        process.exit(1);
      }
    } catch {
      // ok
    }

    await fs.writeFile(cfgPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[mcp-router] wrote ${cfgPath}`);
    // eslint-disable-next-line no-console
    console.log('Next: npm run dev:serve -- --config ' + cfgPath);
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

  const logger = createLogger();
  const upstreams = new UpstreamManager({ logger });

  const configPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
  const configRef = { current: loadConfigFile(configPath) };

  upstreams.setConfigRef(configRef);

  const isLongRunning = cmd === 'serve' || cmd === 'stdio';
  const watch = isLongRunning && !hasFlag(args, '--no-watch');
  const stopWatch = watch ? watchConfigFile(configPath, (c) => (configRef.current = c)) : null;

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
    const port = portArg ? Number(portArg) : configRef.current.listen.http?.port ?? 8080;
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
