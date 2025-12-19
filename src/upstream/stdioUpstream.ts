import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Readable } from 'node:stream';
import path from 'node:path';
import type { McpServerConfig } from '../types.js';
import type { UpstreamClient } from './types.js';
import type { Logger } from '../log.js';
import { SandboxedStdioClientTransport } from './sandboxedStdioTransport.js';

export class StdioUpstreamClient implements UpstreamClient {
  private client: Client | null = null;
  private transport: SandboxedStdioClientTransport | null = null;
  private readonly cfg: McpServerConfig;
  private readonly name: string;
  private readonly logger: Logger | null;
  private readonly sandbox: {
    allowedCommands: string[] | null;
    allowedCwdRoots: string[] | null;
    allowedEnvKeys: string[] | null;
    inheritEnvKeys: string[] | null;
  } | null;
  private connectPromise: Promise<void> | null = null;
  private restartAttempts = 0;
  private readonly restartPolicy: Required<NonNullable<McpServerConfig['restart']>>;
  private stderrSubscribed = false;

  constructor(
    name: string,
    cfg: McpServerConfig,
    opts?: {
      logger?: Logger | null;
      sandbox?: {
        allowedCommands: string[] | null;
        allowedCwdRoots: string[] | null;
        allowedEnvKeys: string[] | null;
        inheritEnvKeys: string[] | null;
      } | null;
    },
  ) {
    this.name = name;
    this.cfg = cfg;
    this.logger = opts?.logger ?? null;
    this.sandbox = opts?.sandbox ?? null;
    this.restartPolicy = {
      maxRetries: cfg.restart?.maxRetries ?? 2,
      initialDelayMs: cfg.restart?.initialDelayMs ?? 200,
      maxDelayMs: cfg.restart?.maxDelayMs ?? 5000,
      factor: cfg.restart?.factor ?? 2,
    };
  }

  private assertSandboxAllowed() {
    if (!this.sandbox) return;
    const allowedCommands = this.sandbox.allowedCommands;
    if (allowedCommands && allowedCommands.length > 0) {
      if (!this.cfg.command || !allowedCommands.includes(this.cfg.command)) {
        throw new Error(
          `Upstream ${this.name} command is not allowed by sandbox.stdio.allowedCommands: ${this.cfg.command ?? '<missing>'}`,
        );
      }
    }
    const allowedCwdRoots = this.sandbox.allowedCwdRoots;
    if (allowedCwdRoots && allowedCwdRoots.length > 0 && this.cfg.cwd) {
      const cwdResolved = path.resolve(this.cfg.cwd);
      const ok = allowedCwdRoots.some((root) => {
        const rootResolved = path.resolve(root);
        return cwdResolved === rootResolved || cwdResolved.startsWith(rootResolved + path.sep);
      });
      if (!ok) {
        throw new Error(
          `Upstream ${this.name} cwd is not allowed by sandbox.stdio.allowedCwdRoots: ${this.cfg.cwd}`,
        );
      }
    }

    const allowedEnvKeys = this.sandbox.allowedEnvKeys;
    if (allowedEnvKeys && allowedEnvKeys.length > 0 && this.cfg.env) {
      for (const k of Object.keys(this.cfg.env)) {
        if (!allowedEnvKeys.includes(k)) {
          throw new Error(`Upstream ${this.name} env key is not allowed by sandbox.stdio.allowedEnvKeys: ${k}`);
        }
      }
    }
  }

  private async sleep(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private nextBackoffMs() {
    const { initialDelayMs, factor, maxDelayMs } = this.restartPolicy;
    const d = Math.floor(initialDelayMs * Math.pow(factor, this.restartAttempts));
    return Math.min(maxDelayMs, Math.max(0, d));
  }

  private async connectIfNeeded() {
    if (this.connectPromise) return this.connectPromise;
    if (this.client) return;

    this.connectPromise = (async () => {
      if (!this.cfg.command) {
        throw new Error(`Upstream ${this.name} is missing command`);
      }
      this.assertSandboxAllowed();

      this.client = new Client({ name: `mcp-router-upstream:${this.name}`, version: '0.1.0' });
      this.transport = new SandboxedStdioClientTransport(
        {
          command: this.cfg.command,
          args: this.cfg.args ?? [],
          cwd: this.cfg.cwd,
          env: this.cfg.env,
          stderr: this.cfg.stderr ?? 'inherit',
        },
        { inheritEnvKeys: this.sandbox?.inheritEnvKeys ?? null },
      );

      const transport = this.transport;
      transport.onerror = (err) => {
        this.logger?.warn('upstream stdio transport error', {
          upstream: this.name,
          message: err.message,
        });
      };
      transport.onclose = () => {
        this.logger?.warn('upstream stdio transport closed', { upstream: this.name, pid: transport.pid });
        void this.reset();
      };

      await this.client.connect(transport);
      this.restartAttempts = 0;
      this.logger?.info('upstream stdio connected', {
        upstream: this.name,
        pid: transport.pid,
        command: this.cfg.command,
      });

      if (!this.stderrSubscribed && this.cfg.stderr === 'pipe') {
        const stderr = transport.stderr as Readable | null;
        if (stderr) {
          this.stderrSubscribed = true;
          stderr.on('data', (chunk) => {
            const text = String(chunk);
            this.logger?.warn('upstream stdio stderr', {
              upstream: this.name,
              pid: transport.pid,
              text: text.length > 4000 ? text.slice(0, 4000) + '…' : text,
            });
          });
        }
      }
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async listTools() {
    const timeout = this.cfg.timeoutMs;
    return this.withRestartRetry(() => this.client!.listTools(undefined, timeout ? { timeout } : undefined));
  }

  async callTool(input: { name: string; arguments: unknown }) {
    const timeout = this.cfg.timeoutMs;
    return this.withRestartRetry(() =>
      this.client!.callTool(
        { name: input.name, arguments: input.arguments as any },
        undefined,
        timeout ? { timeout } : undefined,
      ),
    );
  }

  private async withRestartRetry<T>(fn: () => Promise<T>): Promise<T> {
    await this.connectIfNeeded();
    try {
      return await fn();
    } catch (err) {
      const maxRetries = this.restartPolicy.maxRetries;
      if (this.restartAttempts >= maxRetries) throw err;
      this.restartAttempts += 1;
      const backoff = this.nextBackoffMs();
      this.logger?.warn('upstream stdio retrying after failure', {
        upstream: this.name,
        attempt: this.restartAttempts,
        backoffMs: backoff,
        message: (err as Error).message,
      });
      await this.reset();
      await this.sleep(backoff);
      await this.connectIfNeeded();
      return fn();
    }
  }

  private async reset() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // ignore
    }
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.transport = null;
    }
  }
}
