export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerConfig = {
  enabled: boolean;
  failureThreshold: number;
  openMs: number;
};

export type CircuitBreakerSnapshot = {
  state: CircuitBreakerState;
  failures: number;
  openUntil: number | null;
  halfOpenInFlight: boolean;
};

type Hooks = {
  onStateChange?: (server: string, state: CircuitBreakerState) => void;
  onOpen?: (server: string) => void;
  onFailure?: (server: string) => void;
};

type Entry = {
  state: CircuitBreakerState;
  failures: number;
  openUntil: number | null;
  halfOpenInFlight: boolean;
};

function defaultEntry(): Entry {
  return { state: 'closed', failures: 0, openUntil: null, halfOpenInFlight: false };
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly getConfig: () => CircuitBreakerConfig,
    private readonly hooks: Hooks = {},
  ) {}

  snapshot(server: string): CircuitBreakerSnapshot {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      return { state: 'closed', failures: 0, openUntil: null, halfOpenInFlight: false };
    }
    const entry = this.entries.get(server) ?? defaultEntry();
    return { ...entry };
  }

  canAttempt(server: string, now = Date.now()): boolean {
    const cfg = this.getConfig();
    if (!cfg.enabled) return true;
    const entry = this.entries.get(server);
    if (!entry) return true;

    if (entry.state === 'open') {
      if (!entry.openUntil) return false;
      return now >= entry.openUntil;
    }
    if (entry.state === 'half-open') {
      return !entry.halfOpenInFlight;
    }
    return true;
  }

  beginAttempt(server: string, now = Date.now()): { end: (ok: boolean) => void } {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      return { end: () => {} };
    }

    const entry = this.entries.get(server) ?? defaultEntry();

    if (entry.state === 'open') {
      if (!entry.openUntil || now < entry.openUntil) {
        this.entries.set(server, entry);
        throw new Error('CIRCUIT_OPEN');
      }
      // open timeout elapsed -> half-open
      entry.state = 'half-open';
      entry.openUntil = null;
      entry.halfOpenInFlight = false;
      this.hooks.onStateChange?.(server, entry.state);
    }

    if (entry.state === 'half-open') {
      if (entry.halfOpenInFlight) {
        this.entries.set(server, entry);
        throw new Error('CIRCUIT_HALF_OPEN_BUSY');
      }
      entry.halfOpenInFlight = true;
      this.entries.set(server, entry);
    } else {
      this.entries.set(server, entry);
    }

    let finished = false;
    return {
      end: (ok: boolean) => {
        if (finished) return;
        finished = true;
        this.finishAttempt(server, ok);
      },
    };
  }

  private finishAttempt(server: string, ok: boolean, now = Date.now()) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;

    const entry = this.entries.get(server) ?? defaultEntry();

    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = false;
      if (ok) {
        entry.state = 'closed';
        entry.failures = 0;
        entry.openUntil = null;
        this.hooks.onStateChange?.(server, entry.state);
        this.entries.set(server, entry);
        return;
      }
      // half-open failed -> open immediately
      entry.state = 'open';
      entry.failures = 0;
      entry.openUntil = now + cfg.openMs;
      this.hooks.onFailure?.(server);
      this.hooks.onOpen?.(server);
      this.hooks.onStateChange?.(server, entry.state);
      this.entries.set(server, entry);
      return;
    }

    if (ok) {
      entry.failures = 0;
      this.entries.set(server, entry);
      return;
    }

    entry.failures += 1;
    this.hooks.onFailure?.(server);
    if (entry.failures >= cfg.failureThreshold) {
      entry.state = 'open';
      entry.failures = 0;
      entry.openUntil = now + cfg.openMs;
      this.hooks.onOpen?.(server);
      this.hooks.onStateChange?.(server, entry.state);
    }
    this.entries.set(server, entry);
  }
}

