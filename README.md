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
  "auth": {
    "tokens": [{ "value": "dev-token", "allowedMcpServers": ["upstream1"] }]
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

2) Run HTTP server:

```bash
npm install
npm run dev:serve -- --config ./mcp-router.config.json
```

Then point any HTTP-capable MCP client at:

- Endpoint: `http://127.0.0.1:8080/mcp` (or your configured host/port/path)
- Auth: `Authorization: Bearer dev-token` (or `X-API-Key: dev-token`)

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
