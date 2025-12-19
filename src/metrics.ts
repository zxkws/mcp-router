import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Metrics = {
  registry: Registry;
  observeToolCall: (labels: { server: string; tool: string; ok: boolean }, seconds: number) => void;
  setCircuitState: (labels: { server: string; state: 'closed' | 'open' | 'half-open' }) => void;
  incCircuitOpen: (labels: { server: string }) => void;
  incUpstreamFailure: (labels: { server: string }) => void;
  setUpstreamHealth: (labels: { server: string; status: 'unknown' | 'healthy' | 'unhealthy' }) => void;
  incHealthCheck: (labels: { server: string; ok: boolean }) => void;
};

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const toolCalls = new Counter({
    name: 'mcp_router_tool_calls_total',
    help: 'Total number of forwarded tool calls',
    labelNames: ['server', 'tool', 'ok'] as const,
    registers: [registry],
  });

  const toolDuration = new Histogram({
    name: 'mcp_router_tool_call_duration_seconds',
    help: 'Latency of forwarded tool calls',
    labelNames: ['server', 'tool', 'ok'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const circuitState = new Gauge({
    name: 'mcp_router_upstream_circuit_state',
    help: 'Circuit breaker state for an upstream (1=current state, 0=other states)',
    labelNames: ['server', 'state'] as const,
    registers: [registry],
  });

  const circuitOpens = new Counter({
    name: 'mcp_router_upstream_circuit_opens_total',
    help: 'Number of times an upstream circuit breaker opened',
    labelNames: ['server'] as const,
    registers: [registry],
  });

  const upstreamFailures = new Counter({
    name: 'mcp_router_upstream_failures_total',
    help: 'Number of upstream call/list failures observed by the router',
    labelNames: ['server'] as const,
    registers: [registry],
  });

  const upstreamHealth = new Gauge({
    name: 'mcp_router_upstream_health',
    help: 'Upstream health status from periodic health checks (1=current status, 0=other statuses)',
    labelNames: ['server', 'status'] as const,
    registers: [registry],
  });

  const healthChecks = new Counter({
    name: 'mcp_router_upstream_health_checks_total',
    help: 'Number of upstream health checks performed',
    labelNames: ['server', 'ok'] as const,
    registers: [registry],
  });

  return {
    registry,
    observeToolCall: ({ server, tool, ok }, seconds) => {
      const okLabel = ok ? 'true' : 'false';
      toolCalls.inc({ server, tool, ok: okLabel });
      toolDuration.observe({ server, tool, ok: okLabel }, seconds);
    },
    setCircuitState: ({ server, state }) => {
      circuitState.set({ server, state: 'closed' }, state === 'closed' ? 1 : 0);
      circuitState.set({ server, state: 'open' }, state === 'open' ? 1 : 0);
      circuitState.set({ server, state: 'half-open' }, state === 'half-open' ? 1 : 0);
    },
    incCircuitOpen: ({ server }) => {
      circuitOpens.inc({ server });
    },
    incUpstreamFailure: ({ server }) => {
      upstreamFailures.inc({ server });
    },
    setUpstreamHealth: ({ server, status }) => {
      upstreamHealth.set({ server, status: 'unknown' }, status === 'unknown' ? 1 : 0);
      upstreamHealth.set({ server, status: 'healthy' }, status === 'healthy' ? 1 : 0);
      upstreamHealth.set({ server, status: 'unhealthy' }, status === 'unhealthy' ? 1 : 0);
    },
    incHealthCheck: ({ server, ok }) => {
      healthChecks.inc({ server, ok: ok ? 'true' : 'false' });
    },
  };
}
