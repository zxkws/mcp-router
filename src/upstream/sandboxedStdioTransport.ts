import spawn from 'cross-spawn';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export type SandboxedStdioParams = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: 'inherit' | 'pipe';
};

export type EnvPolicy = {
  /**
   * List of environment keys to inherit from the parent process.
   * - null: use built-in safe defaults
   * - []: inherit nothing
   */
  inheritEnvKeys: string[] | null;
};

const DEFAULT_INHERITED_ENV_VARS =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

function buildEnv(policy: EnvPolicy, env?: Record<string, string>) {
  const inheritedKeys = policy.inheritEnvKeys ?? DEFAULT_INHERITED_ENV_VARS;
  const inherited: Record<string, string> = {};
  for (const key of inheritedKeys) {
    const value = process.env[key];
    if (value === undefined) continue;
    // Skip functions, which are a security risk.
    if (value.startsWith('()')) continue;
    inherited[key] = value;
  }
  return { ...inherited, ...(env ?? {}) };
}

export class SandboxedStdioClientTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private started = false;

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly params: SandboxedStdioParams,
    private readonly envPolicy: EnvPolicy,
  ) {
    this.stderrStream = params.stderr === 'pipe' ? new PassThrough() : null;
  }

  get pid() {
    return this.process?.pid ?? null;
  }

  get stderr() {
    if (this.stderrStream) return this.stderrStream;
    return this.process?.stderr ?? null;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('SandboxedStdioClientTransport already started');
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args ?? [], {
        env: buildEnv(this.envPolicy, this.params.env),
        stdio: ['pipe', 'pipe', this.params.stderr ?? 'inherit'],
        shell: false,
        windowsHide: process.platform === 'win32',
        cwd: this.params.cwd,
      });

      child.on('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });

      child.on('spawn', () => {
        this.process = child as any;
        resolve();
      });

      child.on('close', () => {
        this.process = null;
        this.onclose?.();
      });

      child.stdin.on('error', (err) => this.onerror?.(err));
      child.stdout.on('data', (chunk) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout.on('error', (err) => this.onerror?.(err));

      if (this.stderrStream && child.stderr) {
        child.stderr.pipe(this.stderrStream);
      }
    });
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err as Error);
      }
    }
  }

  async close(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.readBuffer.clear();

    if (!proc) {
      this.onclose?.();
      return;
    }

    const closePromise = new Promise<void>((resolve) => proc.once('close', () => resolve()));

    try {
      proc.stdin.end();
    } catch {
      // ignore
    }

    const wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

    await Promise.race([closePromise, wait(2000)]);
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      await Promise.race([closePromise, wait(2000)]);
    }
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }

    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process?.stdin) {
        throw new Error('Not connected');
      }
      const json = serializeMessage(message);
      if (this.process.stdin.write(json)) {
        resolve();
      } else {
        this.process.stdin.once('drain', resolve);
      }
    });
  }
}

