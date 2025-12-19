import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { NormalizedRouterConfig } from './config.js';
import { authFromToken } from './auth.js';
import { createRouterServer } from './routerServer.js';
import type { Logger } from './log.js';
import type { UpstreamManager } from './upstream/manager.js';
import { TokenBucketRateLimiter } from './rateLimit.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { startHealthChecker } from './healthChecker.js';

export async function startStdioServer(input: {
  configRef: { current: NormalizedRouterConfig };
  token: string | null;
  upstreams: UpstreamManager;
  logger: Logger;
  random?: () => number;
}) {
  const rateLimiter = new TokenBucketRateLimiter();
  const breaker = new CircuitBreaker(
    () => input.configRef.current.routing.circuitBreaker,
    {
      onStateChange: (serverName, state) => input.logger.info('circuit state', { upstream: serverName, state }),
      onOpen: (serverName) => input.logger.warn('circuit opened', { upstream: serverName }),
      onFailure: (serverName) => input.logger.warn('upstream failure', { upstream: serverName }),
    },
  );
  const healthChecker = startHealthChecker({
    configRef: input.configRef,
    upstreams: input.upstreams,
    breaker,
    logger: input.logger,
  });
  const principal = authFromToken(input.configRef.current, input.token);
  const server = createRouterServer({
    configRef: input.configRef,
    principal,
    upstreams: input.upstreams,
    logger: input.logger,
    random: input.random,
    breaker,
    health: healthChecker,
    rateLimiter,
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    healthChecker.stop();
    void input.upstreams.closeAll();
  };
  await server.connect(transport);
}
