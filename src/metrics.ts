import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Metrics = {
  registry: Registry;
  observeToolCall: (labels: { server: string; tool: string; ok: boolean }, seconds: number) => void;
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

  return {
    registry,
    observeToolCall: ({ server, tool, ok }, seconds) => {
      const okLabel = ok ? 'true' : 'false';
      toolCalls.inc({ server, tool, ok: okLabel });
      toolDuration.observe({ server, tool, ok: okLabel }, seconds);
    },
  };
}

