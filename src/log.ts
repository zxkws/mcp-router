export type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

export function createLogger(): Logger {
  const base = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };
  return {
    info: (msg, fields) => base('info', msg, fields),
    warn: (msg, fields) => base('warn', msg, fields),
    error: (msg, fields) => base('error', msg, fields),
  };
}

