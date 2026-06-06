import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';

import { DISCLAIMER } from './constants';
import { AUTHED_TOOLS } from './mcp-authed';
import { capabilities } from './registry';
import { VERSION } from './version';

/**
 * Render an error as actionable text for the calling agent. ZodError carries a
 * JSON blob in `.message`; flatten it to `path: message` pairs so the model can
 * see exactly which argument to fix and retry, rather than parsing raw JSON.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return `Invalid arguments: ${issues}`;
  }
  return (err as Error).message;
}

/** Sent to the agent on initialize — frames what SupStack is and the wellness disclaimer. */
const SERVER_INSTRUCTIONS =
  'SupStack exposes evidence-based supplement data (research, search, compare, studies, ' +
  'interactions, stack, export, define) over the public SupStack API. Account-scoped tools ' +
  '(recommend, profile, experiments, adherence, and cloud stack pull/push/sync) require the ' +
  'user to be signed in via `supstack login`; if they are not, the tool returns a clear ' +
  '"not logged in" error. ' +
  DISCLAIMER +
  ' Present findings as evidence ("studies have examined X for Y"), not as instructions to ' +
  'take or stop a supplement, and route out-of-range or clinical questions to a provider.';

/**
 * Build the SupStack MCP server.
 *
 * Tools are generated from the SAME capability registry the CLI uses, so the
 * two surfaces cannot drift. We use the low-level `Server` (not the high-level
 * `McpServer.tool` helper) and produce each tool's JSON Schema ourselves with
 * zod v4's native `z.toJSONSchema` — this avoids coupling to whatever zod
 * version the SDK's schema helpers expect. `io: 'input'` represents the input
 * side, so fields with defaults are correctly optional for the agent.
 *
 * Exported (rather than only run) so it can be exercised with an in-memory
 * transport in tests.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: 'supstack', version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const toJsonSchema = (schema: z.ZodTypeAny): { type: 'object'; [k: string]: unknown } =>
    z.toJSONSchema(schema, { io: 'input' }) as { type: 'object'; [k: string]: unknown };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...capabilities.map((cap) => ({
        name: cap.mcp.toolName,
        description: cap.mcp.description,
        inputSchema: toJsonSchema(cap.inputSchema),
        annotations: {
          // Hints for the agent. Only the local-stack tool mutates state; the rest
          // are read-only API lookups that reach an external service.
          readOnlyHint: cap.mcp.mutates !== true,
          openWorldHint: true,
        },
      })),
      ...AUTHED_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.schema),
        annotations: { readOnlyHint: t.mutates !== true, openWorldHint: true },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const cap = capabilities.find((c) => c.mcp.toolName === request.params.name);
    if (cap) {
      try {
        const output = await cap.handler(cap.inputSchema.parse(args));
        return { content: [{ type: 'text', text: JSON.stringify(cap.format.json(output), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: formatToolError(err) }] };
      }
    }
    const authed = AUTHED_TOOLS.find((t) => t.name === request.params.name);
    if (authed) {
      try {
        const output = await authed.handler(authed.schema.parse(args));
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: formatToolError(err) }] };
      }
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  });

  return server;
}

/** Run the MCP server. Defaults to stdio; a transport can be injected for tests. */
export async function runMcpServer(transport?: Transport): Promise<void> {
  const server = buildMcpServer();
  await server.connect(transport ?? new StdioServerTransport());
}
