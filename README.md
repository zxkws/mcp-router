# mcp-router

An open-source MCP router that proxies multiple MCP servers behind a single MCP endpoint (HTTP or Stdio).

## Features

- **Multi-Transport**: Supports `stdio` and Streamable HTTP (`/mcp`) transports.
- **Hierarchical Discovery**: Aggregates tools from multiple upstreams (`list_providers`, `tools.list`, `tools.call`).
- **Flexible Routing**: Route by provider name, tags (`tag:demo`), or versions (`version:^1.0`).
- **Zero Config Mode**: Run and expose any MCP server command instantly (`mcpr run ...`).
- **Security**: Token-based authentication (Bearer/X-API-Key) and basic stdio guardrails.
- **Observability**: Health checks, circuit breakers, and metrics (`/metrics`).
- **Config Import**: Import existing configs from Claude Desktop, Codex, or generic JSON/TOML.

## Quick Start

### 1. Zero Config (Instant Run)

Run any MCP server command (like `npx`) and expose it via the router without creating a config file.

**Stdio Mode (for Claude Desktop):**
```bash
npx -y --package git+https://github.com/zxkws/mcp-router.git mcpr run -- npx -y @modelcontextprotocol/server-memory
```

**HTTP Mode (Bridge to HTTP):**
```bash
# Exposes the server at http://localhost:8080/mcp
npx -y --package git+https://github.com/zxkws/mcp-router.git mcpr run --port 8080 -- npx -y @modelcontextprotocol/server-memory
```

### 2. Configured Mode (Recommended for Production)

1. **Create Configuration:**
   ```bash
   npx --yes --package git+https://github.com/zxkws/mcp-router.git mcpr init
   ```

2. **Run:**
   ```bash
   # HTTP Server
   npx --yes --package git+https://github.com/zxkws/mcp-router.git mcpr serve
   ```

### 3. Claude Desktop Setup

To use `mcp-router` as your primary entry point in Claude Desktop:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": [
        "-y",
        "--package", "git+https://github.com/zxkws/mcp-router.git",
        "mcpr",
        "run",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```
*(Note: The above example runs a single server. To run multiple, create a `mcp-router.config.json` and use `mcpr stdio --config ...` instead.)*

## Configuration

The router is driven by `mcp-router.config.json` (created via `mcpr init`).

### Basic Example

```json
{
  "listen": { 
    "http": { "port": 8080, "path": "/mcp" }, 
    "stdio": true 
  },
  "mcpServers": {
    "local-server": {
      "transport": "stdio",
      "command": "node",
      "args": ["./path/to/server.js"],
      "enabled": true
    },
    "remote-server": {
      "transport": "streamable-http",
      "url": "http://localhost:9001/mcp",
      "enabled": true
    }
  }
}
```

### Importing Existing Configs

Merge existing server definitions from other tools:

```bash
# Import from Claude Desktop
npx mcpr import --from ~/Library/Application\ Support/Claude/claude_desktop_config.json --format claude
```

## Advanced Features

### Routing & Discovery
- **Hierarchical**: Only router tools are exposed initially.
- **Namespaced**: Upstream tools exposed as `serverName.toolName`.
- **Tag/Version**: Use `tag:tagname` or `version:^1.0` in tool selectors to dynamically route to available upstreams.

### Reliability
The router includes a **Circuit Breaker** and **Health Checks** to manage upstream failures automatically.
```json
{
  "routing": {
    "circuitBreaker": { "enabled": true, "failureThreshold": 3 },
    "healthChecks": { "enabled": true, "intervalMs": 15000 }
  }
}
```

## Environment Variables

- `PORT`: Overrides `listen.http.port` (e.g. `PORT=3000 mcpr serve`).

## License

MIT
