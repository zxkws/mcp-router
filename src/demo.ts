import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server(
  {
    name: 'mcp-router-demo',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echoes back the input. A demonstration tool provided by mcp-router.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      },
      {
        name: 'add',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo') {
    const message = String(request.params.arguments?.message ?? 'Hello from Demo!');
    return {
      content: [{ type: 'text', text: `Echo: ${message}` }],
    };
  }
  if (request.params.name === 'add') {
    const a = Number(request.params.arguments?.a ?? 0);
    const b = Number(request.params.arguments?.b ?? 0);
    return {
      content: [{ type: 'text', text: String(a + b) }],
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('Demo server failed:', err);
  process.exit(1);
});
