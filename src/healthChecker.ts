import type { NormalizedRouterConfig } from './config.js';
import type { UpstreamManager } from './upstream/manager.js';
import type { Logger } from './log.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export type UpstreamHealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export type UpstreamHealthSnapshot = {
  status: UpstreamHealthStatus;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

type Entry = UpstreamHealthSnapshot;

function defaultEntry(): Entry {
  return { status: 'unknown', lastOkAt: null, lastErrorAt: null, lastError: null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('HEALTHCHECK_TIMEOUT')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function startHealthChecker(input: {
  configRef: { current: NormalizedRouterConfig };
  upstreams: UpstreamManager;
  breaker: CircuitBreaker;
  logger: Logger;
  metrics?: {
    setUpstreamHealth?: (labels: { server: string; status: UpstreamHealthStatus }) => void;
    incHealthCheck?: (labels: { server: string; ok: boolean }) => void;
  };
}) {
  const state = new Map<string, Entry>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (server: string): UpstreamHealthSnapshot => {
    return state.get(server) ?? defaultEntry();
  };

  const setStatus = (server: string, next: Partial<Entry>) => {
    const prev = state.get(server) ?? defaultEntry();
    const merged: Entry = { ...prev, ...next };
    state.set(server, merged);
    input.metrics?.setUpstreamHealth?.({ server, status: merged.status });
  };

  const checkOnce = async () => {
    const cfg = input.configRef.current;
    const hc = cfg.routing.healthChecks;
    if (!hc.enabled) return;

    const entries = Object.entries(cfg.mcpServers).filter(([, s]) => s.enabled);
    for (const [name, serverCfg] of entries) {
      if (stopped) return;
      if (serverCfg.transport === 'stdio' && !hc.includeStdio) continue;

      let attempt: { end: (ok: boolean) => void } | null = null;
      try {
        attempt = input.breaker.beginAttempt(name);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === 'CIRCUIT_OPEN' || msg === 'CIRCUIT_HALF_OPEN_BUSY') {
          setStatus(name, { status: 'unhealthy', lastErrorAt: Date.now(), lastError: msg });
          input.metrics?.incHealthCheck?.({ server: name, ok: false });
          continue;
        }
        setStatus(name, { status: 'unhealthy', lastErrorAt: Date.now(), lastError: msg });
        input.metrics?.incHealthCheck?.({ server: name, ok: false });
        continue;
      }

      try {
        const client = input.upstreams.getClient(name, serverCfg);
        await withTimeout(client.listTools(), hc.timeoutMs);
        attempt.end(true);
        setStatus(name, { status: 'healthy', lastOkAt: Date.now(), lastError: null });
        input.metrics?.incHealthCheck?.({ server: name, ok: true });
      } catch (err) {
        if (attempt) {
          if (err instanceof McpError && err.code !== ErrorCode.InternalError) {
            attempt.end(true);
          } else {
            attempt.end(false);
          }
        }
        const message =
          (err as Error).message === 'HEALTHCHECK_TIMEOUT'
            ? `timeout after ${hc.timeoutMs}ms`
            : (err as Error).message;
        setStatus(name, { status: 'unhealthy', lastErrorAt: Date.now(), lastError: message });
        input.metrics?.incHealthCheck?.({ server: name, ok: false });
        input.logger.warn('upstream health check failed', { upstream: name, message });
      }
    }
  };

  const loop = async () => {
    if (stopped) return;
    try {
      await checkOnce();
    } finally {
      if (stopped) return;
      const intervalMs = input.configRef.current.routing.healthChecks.intervalMs;
      timer = setTimeout(() => void loop(), intervalMs);
    }
  };

  void loop();

  return {
    snapshot,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

