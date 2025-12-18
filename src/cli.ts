#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { loadConfigFile, defaultConfigPath, watchConfigFile } from './config.js';
import { createLogger } from './log.js';
import { UpstreamManager } from './upstream/httpUpstream.js';
import { startHttpServer } from './httpServer.js';
import { startStdioServer } from './stdioServer.js';

function argValue(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function usage(exitCode = 0) {
  // eslint-disable-next-line no-console
  console.log(
    [
      'mcp-router (mcpr)',
      '',
      'Usage:',
      '  mcpr serve  --config ./mcp-router.config.json [--host 127.0.0.1] [--port 8080] [--path /mcp] [--no-watch]',
      '  mcpr stdio  --config ./mcp-router.config.json --token <TOKEN> [--no-watch]',
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

  const logger = createLogger();
  const upstreams = new UpstreamManager();

  const configPath = path.resolve(argValue(args, '--config') ?? defaultConfigPath());
  const configRef = { current: loadConfigFile(configPath) };

  const watch = !hasFlag(args, '--no-watch');
  const stopWatch = watch ? watchConfigFile(configPath, (c) => (configRef.current = c)) : null;

  const shutdown = async () => {
    stopWatch?.();
    await upstreams.closeAll();
  };
  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

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
    return;
  }

  usage(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[mcp-router] fatal: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
