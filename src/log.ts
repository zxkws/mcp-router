import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

export function createLogger(): Logger {
  let stream: fs.WriteStream | null = null;
  try {
    const logDir = path.join(os.homedir(), '.mcpr');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'mcp-router.log');
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => {
      // Ignore log write errors to avoid crashing the main process
    });
  } catch {
    // Ignore setup errors
  }

  const base = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    };
    const json = JSON.stringify(line);
    // eslint-disable-next-line no-console
    console.error(json);
    if (stream && !stream.destroyed) {
      stream.write(json + '\n');
    }
  };
  return {
    info: (msg, fields) => base('info', msg, fields),
    warn: (msg, fields) => base('warn', msg, fields),
    error: (msg, fields) => base('error', msg, fields),
  };
}

