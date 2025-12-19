# Configuration reference

`mcp-router` loads `mcp-router.config.json` by default (or via CLI `--config`).

The config is **strict JSON**: unknown keys are rejected.

## Top-level fields

- `listen` (optional)
- `admin` (optional)
- `toolExposure` (optional)
- `routing` (optional)
- `audit` (optional)
- `projects` (optional)
- `auth` (optional)
- `sandbox` (optional)
- `mcpServers` (optional)
- `upstreams` (optional, legacy alias for `mcpServers`)

## `listen`

```json
{ "listen": { "http": { "host": "127.0.0.1", "port": 8080, "path": "/mcp" }, "stdio": true } }
```

- `listen.http` (optional): enable the HTTP server
  - `host` (default: `127.0.0.1`)
  - `port` (default: `8080`)  
    - Use `0` to let the OS choose a free port.
  - `path` (default: `/mcp`)
- `listen.stdio` (default: `true`): enable stdio server (used by `mcpr stdio`)

## `admin`

Optional embedded admin UI (served by the HTTP server).

```json
{ "admin": { "enabled": true, "path": "/admin", "allowUnauthenticated": false } }
```

- `enabled` (default: `false`): enable the admin UI and import endpoints
- `path` (default: `/admin`): base path for the admin UI
- `allowUnauthenticated` (default: `false`): allow access when `auth.tokens` is empty
  
Note: admin UI is only available when `listen.http` is enabled.

## `toolExposure`

Controls which tools the router exposes downstream:

- `hierarchical` (default): router-only tools
  - `list_providers`
  - `tools.list`
  - `tools.call`
- `namespaced`: exposes upstream tools as `provider.tool` (and keeps `list_providers`)
- `both`: exposes both router tools and namespaced tools

## `mcpServers` (and `upstreams`)

`mcpServers` is a map of `name -> MCP server config`.

```json
{
  "mcpServers": {
    "demo": { "transport": "streamable-http", "url": "http://127.0.0.1:9001/mcp", "enabled": true }
  }
}
```

`upstreams` is a legacy alias. If both exist, `mcpServers` wins.

### Common fields (all transports)

- `enabled` (default: `true`)
- `tags` (optional): used by selectors like `tag:demo`
- `version` (optional): used by selectors like `version:^1.2.0` and `tag:demo@^1.2.0`
- `timeoutMs` (optional): per-request timeout

### `transport: "streamable-http"` / `"http"`

- `url` (required): full upstream URL (for example `http://127.0.0.1:9001/mcp`)
- `headers` (optional): static headers added to upstream requests

### `transport: "stdio"`

- `command` (required): executable name/path
- `args` (optional): argv list
- `cwd` (optional): working directory
- `env` (optional): extra environment variables
- `stderr` (optional): `inherit` (default) or `pipe`
- `restart` (optional): retry policy when the child process dies / disconnects
  - `maxRetries` (default: `2`)
  - `initialDelayMs` (default: `200`)
  - `maxDelayMs` (default: `5000`)
  - `factor` (default: `2`)

## `auth` and `projects`

Auth is token-based. If `auth.tokens` is missing or empty, auth is disabled (no token required).

```json
{
  "projects": [{ "id": "p1", "allowedMcpServers": ["demo"], "allowedTags": ["demo"] }],
  "auth": {
    "tokens": [
      {
        "value": "dev-token",
        "projectId": "p1",
        "allowedMcpServers": ["demo"],
        "allowedTags": ["demo"],
        "rateLimit": { "requestsPerMinute": 120 }
      }
    ]
  }
}
```

- `auth.tokens[].value` (required): token string
- `auth.tokens[].projectId` (optional): links to `projects[].id`
- `auth.tokens[].allowedMcpServers` / `projects[].allowedMcpServers` (optional): allowlist
- `auth.tokens[].allowedTags` / `projects[].allowedTags` (optional): allowlist
- `auth.tokens[].rateLimit.requestsPerMinute` / `projects[].rateLimit.requestsPerMinute` (optional): per-token/project rate limit

Effective policy:

- Allowed MCP servers/tags = intersection of project allowlist and token allowlist (if both exist).
- Rate limit = token rate limit if present, else project rate limit.

## `routing` (selectors, health checks, circuit breaker)

Router tools `tools.list` and `tools.call` accept a `provider` string. It can be:

- An explicit provider name (example: `"demo"`)
- A selector:
  - `tag:<tag>` (example: `"tag:demo"`)
  - `tag:<tag>@<semverRange>` (example: `"tag:demo@^1.0.0"`)
  - `version:<semverRange>` (example: `"version:>=1 <2"`)

If multiple providers match a selector, `routing.selectorStrategy` chooses among them:

- `roundRobin` (default)
- `random`

### `routing.healthChecks`

```json
{ "routing": { "healthChecks": { "enabled": true, "intervalMs": 15000, "timeoutMs": 5000, "includeStdio": false } } }
```

- `enabled` (default: `true`)
- `intervalMs` (default: `15000`)
- `timeoutMs` (default: `5000`)
- `includeStdio` (default: `false`): whether to health-check `transport:"stdio"` upstreams

### `routing.circuitBreaker`

```json
{ "routing": { "circuitBreaker": { "enabled": true, "failureThreshold": 3, "openMs": 30000 } } }
```

- `enabled` (default: `true`)
- `failureThreshold` (default: `3`): consecutive failures to open the circuit
- `openMs` (default: `30000`): cooldown window before trying again

## `audit`

Audit logs are JSON lines on stdout.

```json
{ "audit": { "enabled": true, "logArguments": false, "maxArgumentChars": 2000 } }
```

- `enabled` (default: `true`)
- `logArguments` (default: `false`)
- `maxArgumentChars` (default: `2000`)

## `sandbox.stdio` (guardrails)

This is a lightweight guardrail for `transport:"stdio"` upstreams (not an OS sandbox).

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

- `allowedCommands`: allowlist for the `command` field
- `allowedCwdRoots`: allowlist for `cwd` (must be under one of the roots)
- `allowedEnvKeys`: allowlist for keys in `env`
- `inheritEnvKeys`: allowlist for inherited environment variables (everything else is dropped)
