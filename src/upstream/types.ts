export type UpstreamToolList = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
};

export type UpstreamToolCallResult = {
  content: Array<{ type: string; [k: string]: unknown }>;
  structuredContent?: unknown;
};

export type UpstreamClient = {
  listTools: () => Promise<UpstreamToolList>;
  callTool: (input: { name: string; arguments: unknown }) => Promise<UpstreamToolCallResult>;
  close: () => Promise<void>;
};

