# mcp-router

**The Central Hub for your MCP Servers.**

Solve the problem of configuring the same MCP servers (Filesystem, Git, Memory, etc.) repeatedly in every IDE (Claude, Codex, Cursor, etc.). Configure them once in `mcp-router`, and point all your IDEs to this single router.

## How it works

```mermaid
graph LR
    IDE1[Claude Desktop] --> Router[mcp-router]
    IDE2[Codex] --> Router
    IDE3[Cursor] --> Router
    
    Router --> S1[Filesystem Server]
    Router --> S2[Memory Server]
    Router --> S3[Postgres Server]
```

## Setup Guide

### 1. Initialize Configuration

Run this command to create the central config file at `~/.mcpr/mcp-router.config.json`:

```bash
npx --yes --package git+https://github.com/zxkws/mcp-router.git mcpr init
```

### 2. Add Servers

Edit `~/.mcpr/mcp-router.config.json` to include your tools.

**Example Configuration:**

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/yourname/workspace"],
      "enabled": true
    },
    "memory": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    }
  }
}
```

### 3. Connect your IDEs

Now point your IDEs to the router. No need to specify config paths anymore—it automatically loads from `~/.mcpr/mcp-router.config.json`.

#### For Codex (`codex.toml`)

```toml
[mcp_servers.hub]
command = "npx"
args = [
    "-y",
    "--package", "git+https://github.com/zxkws/mcp-router.git",
    "mcpr",
    "stdio"
]
```

#### For Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "hub": {
      "command": "npx",
      "args": [
        "-y",
        "--package", "git+https://github.com/zxkws/mcp-router.git",
        "mcpr",
        "stdio"
      ]
    }
  }
}
```

---

## Why use this?

1.  **Write Once, Run Everywhere**: Add a new tool to your config, and it instantly appears in Claude, Codex, and any other client.
2.  **No Port Conflicts**: The router manages the connections via `stdio` or a single HTTP port.
3.  **Unified Logs**: Centralized logging for all tool usage.

## Advanced Usage

### Importing existing configs

Import your existing Claude config into your new central hub:

```bash
npx mcpr import --from ~/Library/Application\ Support/Claude/claude_desktop_config.json --format claude
```

### Local Project Config

If you want a project-specific config, just place a `mcp-router.config.json` in your project root. `mcp-router` will prioritize it over the global one in `~/.mcpr/`.

### Built-in Demo

Quickly test if everything is working:

```bash
npx mcpr demo
```

## License

MIT