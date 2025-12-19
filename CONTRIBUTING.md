# Contributing

Thanks for helping improve `mcp-router`.

## Development

Requirements:

- Node.js 20+

Install dependencies:

```bash
cd mcp-router
npm ci
```

Run tests:

```bash
npm test
```

Run locally (HTTP):

```bash
npm run dev:serve -- --config ./mcp-router.config.json
```

Run locally (stdio):

```bash
npm run dev:stdio -- --config ./mcp-router.config.json --token dev-token
```

## Reporting issues

- For bugs: include config snippet (with secrets removed), expected vs actual behavior, and logs if possible.
- For feature requests: describe the user story and expected MCP client(s).

