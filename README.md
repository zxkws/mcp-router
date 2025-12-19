# mcp-router

An open-source MCP router that proxies multiple MCP servers behind a single MCP endpoint.

## MVP features

- Downstream transports: `stdio` + Streamable HTTP (`/mcp`)
- Config-driven upstream list (`mcp-router.config.json`)
- Hierarchical discovery:
  - `list_providers`
  - `tools.list` (by provider)
  - `tools.call` (forward tool calls)
- Token auth for HTTP (Bearer / X-API-Key) and for stdio (CLI `--token`)
- `/healthz` and `/metrics` endpoints (HTTP mode)

## Quick start

1) Create `mcp-router.config.json`:

```json
{
  "listen": { "http": { "port": 8080, "path": "/mcp" }, "stdio": true },
  "toolExposure": "hierarchical",
  "projects": [
    { "id": "p1", "name": "Project 1", "allowedMcpServers": ["upstream1"] }
  ],
  "auth": {
    "tokens": [
      {
        "value": "dev-token",
        "projectId": "p1",
        "allowedMcpServers": ["upstream1"],
        "rateLimit": { "requestsPerMinute": 120 }
      }
    ]
  },
  "mcpServers": {
    "upstream1": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:9001/mcp",
      "enabled": true
    }
  }
}
```

Or scaffold a starter config:

```bash
npm run build
node ./dist/cli.js init --config ./mcp-router.config.json
```

`toolExposure` modes:

- `hierarchical` (default): only show router tools (`list_providers`, `tools.list`, `tools.call`)
- `namespaced`: expose upstream tools as `provider.tool` (and keep `list_providers`)
- `both`: expose both router tools and namespaced tools

Audit logging (stdout JSON) is enabled by default and does not log tool arguments unless you opt in:

```json
{
  "audit": { "enabled": true, "logArguments": false, "maxArgumentChars": 2000 }
}
```

Upstream `stdio` example:

```json
{
  "mcpServers": {
    "local1": {
      "transport": "stdio",
      "command": "node",
      "args": ["./path/to/upstream-server.js"],
      "stderr": "pipe",
      "restart": { "maxRetries": 2, "initialDelayMs": 200, "maxDelayMs": 5000, "factor": 2 },
      "timeoutMs": 60000,
      "enabled": true
    }
  }
}
```

Optional stdio sandbox guardrails (lightweight):

```json
{
  "sandbox": {
    "stdio": {
      "allowedCommands": ["node"],
      "allowedCwdRoots": ["/absolute/path/to/allowed/root"],
      "allowedEnvKeys": ["NODE_ENV", "PATH"],
      "inheritEnvKeys": ["HOME", "PATH", "SHELL", "TERM", "USER"]
    }
  }
}
```

2) Run HTTP server:

```bash
npm install
npm run dev:serve -- --config ./mcp-router.config.json
```

## Import existing MCP configs

You can import MCP server definitions from Claude, Codex (TOML), Gemini, 1MCP, or raw JSON and merge them into your router config.

CLI:

```bash
node ./dist/cli.js import --config ./mcp-router.config.json --from /path/to/claude_desktop_config.json --format claude
node ./dist/cli.js import --config ./mcp-router.config.json --from /path/to/config.toml --format codex --conflict rename --tag imported
```

Paste via stdin:

```bash
cat /path/to/claude_desktop_config.json | node ./dist/cli.js import --config ./mcp-router.config.json --from -
```

Optional admin UI (enable in config):

```json
{ "admin": { "enabled": true, "path": "/admin", "allowUnauthenticated": false } }
```

Then open `http://127.0.0.1:8080/admin` (or your configured host/port).
If `auth.tokens` is empty, set `allowUnauthenticated: true` or add a token.

## Config reference

- Full config reference: `docs/config.md`
- Example configs: `examples/configs/`

## Examples

Single upstream (works with the built-in mock upstream):

```bash
node examples/mock-upstream.mjs
npm run dev:serve -- --config examples/configs/single-upstream.json
```

Tool exposure: `both` (router tools + `provider.tool`):

```bash
node examples/mock-upstream.mjs
npm run dev:serve -- --config examples/configs/tool-exposure-both.json
```

Tag routing with two upstreams (start two mock upstreams on different ports):

```bash
PORT=9001 node examples/mock-upstream.mjs
PORT=9002 node examples/mock-upstream.mjs
npm run dev:serve -- --config examples/configs/tag-routing-two-upstreams.json
```

## Testing (no Claude/Codex required)

All automated tests (`npm test`) use the official MCP SDK and local loopback sockets only.

Manual smoke tests (Node.js only):

1) Terminal A: start a mock upstream:

```bash
node examples/mock-upstream.mjs
```

2) Terminal B: start the router:

```bash
npm run dev:serve -- --config ./mcp-router.config.json
```

3) Terminal C: run the smoke client:

```bash
npm run build
npm run smoke:http
```

Stdio smoke:

```bash
npm run build
npm run smoke:stdio
```

Optional: validate config:

```bash
npm run build
node ./dist/cli.js validate --config ./mcp-router.config.json
```

Then point any HTTP-capable MCP client at:

- Endpoint: `http://127.0.0.1:8080/mcp` (or your configured host/port/path)
- Auth: `Authorization: Bearer dev-token` (or `X-API-Key: dev-token`)

Deprecated SSE transport (for older clients) is also available on the same host/port:

- SSE stream (GET): `/sse`
- Messages (POST): `/messages?sessionId=...` (the client gets this from the `endpoint` SSE event)

3) Run stdio mode (for Claude Desktop / Cline):

```bash
npm run dev:stdio -- --config ./mcp-router.config.json --token dev-token
```

Example Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-router": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-router/dist/cli.js",
        "stdio",
        "--config",
        "/absolute/path/to/mcp-router/mcp-router.config.json",
        "--token",
        "dev-token",
        "--no-watch"
      ]
    }
  }
}
```

## Notes

- If the configured HTTP port is already in use, the server exits with a clear error. Set `"listen.http.port": 0` to let the OS pick a free port, or override via `--port`.

## FAQ

- Port already in use (`EADDRINUSE`): change `"listen.http.port"`, pass `--port`, or set the port to `0` for auto.
- Getting `Missing token` / `Invalid token`: ensure `auth.tokens` contains your token and send `Authorization: Bearer <token>` (or `X-API-Key`).
- `Unknown provider: ...`: the provider name doesn’t exist in `mcpServers` (or is disabled).
- `No providers match selector: tag:.../version:...`: check upstream `tags`/`version`, token/project allowlists, and `enabled`.
- `All providers matching selector are temporarily unavailable`: health checks/circuit breaker marked matches unavailable; check upstream reachability and wait for `openMs`.
- Config parse errors on extra keys: the config is strict JSON; remove unknown fields.

## Roadmap (later)

- More routing strategies for selectors (e.g. least-latency).
- Stronger stdio sandboxing (OS-level resource limits / isolation).

## Sandbox note

The current stdio “sandbox” is a guardrail (command/cwd allowlists + safe env inheritance), not a strong OS sandbox (no network/filesystem syscall isolation yet).

## Tag routing (beta)

If you don’t want to pin to a specific upstream name, `tools.list` / `tools.call` accept a provider selector:

- `provider: "tag:<tag>"` (example: `"tag:demo"`)
- `provider: "tag:<tag>@<versionRange>"` (example: `"tag:demo@^1.0.0"`)
- `provider: "version:<versionRange>"` (example: `"version:1.2.3"`)

When multiple upstreams share the tag, the router picks one (round-robin per connection).

Projects/tokens can also restrict access by tags:

```json
{
  "projects": [{ "id": "p1", "allowedTags": ["demo"] }],
  "auth": { "tokens": [{ "value": "token", "projectId": "p1", "allowedTags": ["demo"] }] }
}
```

## Version routing (beta)

If you set `mcpServers.<name>.version`, you can route by semver ranges via selectors above (using npm-style ranges like `1.2.3`, `^1.2.0`, `~1.2.3`, `>=1.2.0 <2`).

## Circuit breaker (beta)

By default, the router uses a simple circuit breaker: after N consecutive upstream failures, that upstream is marked unavailable for a cooldown window, and selectors like `tag:` / `version:` will avoid it.

```json
{
  "routing": {
    "selectorStrategy": "roundRobin",
    "healthChecks": { "enabled": true, "intervalMs": 15000, "timeoutMs": 5000, "includeStdio": false },
    "circuitBreaker": { "enabled": true, "failureThreshold": 3, "openMs": 30000 }
  }
}
```

`selectorStrategy` controls how `tag:` / `version:` selectors choose among multiple matches:

- `roundRobin` (default)
- `random`

`healthChecks` periodically calls `tools/list` on upstreams to maintain a best-effort health view and to proactively open the circuit breaker for down upstreams.

Notes:

- Health checks are best-effort and may report a transient view (network hiccups, restarts, etc.).
- `includeStdio` is off by default because stdio health checks can be more expensive (spawning processes).
