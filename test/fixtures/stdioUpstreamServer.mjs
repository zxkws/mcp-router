import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'stdio-upstream', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echo input message',
    inputSchema: { message: z.string() },
    outputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
    structuredContent: { message },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

