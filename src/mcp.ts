import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';

import { DISCLAIMER } from './constants';
import { urgentTopHidesMonitoring } from './experiments';
import { ApiError, setClientTag } from './http';
import { AUTHED_TOOLS } from './mcp-authed';
import { capabilities } from './registry';
import { networkLossText, UnknownOutcomeError } from './unknown-outcome';
import { VERSION } from './version';

/**
 * Render an error as actionable text for the calling agent. ZodError carries a
 * JSON blob in `.message`; flatten it to `path: message` pairs so the model can
 * see exactly which argument to fix and retry, rather than parsing raw JSON.
 *
 * An API refusal keeps its body (pharmacist ruling 291 e2e, 7 October 2026):
 * a 409 from a check-in, a correction or a restart carries what the agent must
 * act on, `safetyAction` (the instruction to relay first, word for word),
 * `restartRecordProblems`, `populationPlansRequired`, `heldExperiment`,
 * `missing`. The tool descriptions promise those fields, and the MCP server
 * used to pass on only the message ("Follow the instruction in safetyAction."
 * with no safetyAction), so a renewed screen reporting an emergency at a
 * restart reached the agent without its emergency instruction.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return `Invalid arguments: ${issues}`;
  }
  if (err instanceof ApiError && err.body !== null && typeof err.body === 'object') {
    return `${err.message}\n${JSON.stringify(err.body, null, 2)}`;
  }
  // Item 1110 row 12: a lost connection is told as a read that did not complete or an update whose outcome is unknown.
  if (err instanceof ApiError && networkLossText(err)) return `${err.message}\n${networkLossText(err)}`;
  return (err as Error).message;
}

/**
 * Pharmacist ruling 453 (12 October 2026, owner-approved): "require the urgent
 * routed instruction to be presented before generic advice on every channel,
 * including MCP ... A message only in nested JSON is not evidence that the
 * actual user sees the urgent action." The safety text a tool result or a
 * refusal carries, as plain text, in the order the reader must see it: the
 * routed instruction (heading, instruction, every further distinct
 * instruction) first, then its footer and notes, then a refusal's own message
 * and footer, then the eligibility rule. Empty when there is nothing to relay
 * (a monitor-only action is not relayed ahead of the result).
 *
 * The server sends it as the FIRST content block, ahead of the JSON, so the
 * text a client receives starts with it. It cannot make a model show it: the
 * tool descriptions still say to relay it first, word for word.
 */
export function relayFirstText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const lines: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '' && !lines.includes(v.trim())) lines.push(v.trim());
  };
  const action = (b.safetyAction ?? (b.data as Record<string, unknown> | undefined)?.safetyAction) as
    | {
        category?: string;
        pauses?: boolean;
        blocksStart?: boolean;
        statusHold?: boolean;
        heading?: string;
        instruction?: string;
        actions?: { instruction?: string; category?: string; urgency?: string }[];
        note?: string;
        pauseStatusNote?: string;
        restartPlanNote?: string;
        endedNote?: string;
        endedTail?: string;
        otherWarnings?: { heading?: string; text?: string };
      }
    | null
    | undefined;
  if (action && (action.category !== 'monitor' || action.pauses || action.blocksStart || action.statusHold)) {
    push(action.heading);
    // Ruling 653: her W653 lead before the event action and its tail after it, on an experiment that ended.
    push(action.endedNote);
    push(action.instruction);
    // Finding R4-03: no competing monitoring advice under an urgent top action.
    const top = (action.actions ?? [])[0];
    for (const x of action.actions ?? []) if (!urgentTopHidesMonitoring(top, x)) push(x.instruction);
    // Item 756 (R4-03): the escalation warnings of the hidden monitoring instruction, under her heading.
    push(action.otherWarnings?.heading);
    push(action.otherWarnings?.text);
    push(action.endedTail);
    push(action.note);
    push(action.pauseStatusNote);
    push(action.restartPlanNote);
  }
  // Ruling 654: the effect of ending, before an uninformed abandon (nothing was changed).
  if (b.confirmationRequired === true) push(b.message);
  const pending = b.pendingAnswer as { heading?: string; instruction?: string } | undefined;
  if (pending && typeof pending === 'object') {
    push(pending.heading);
    push(pending.instruction);
  }
  // Owner call O-6 (14 October 2026): a held experiment read
  // (supstack_experiments_get) carries the refusal its restart would get. Its
  // text goes first too, in the order a refused restart prints it.
  const held = b.held === true ? (b.heldRefusal as Record<string, unknown> | undefined) : undefined;
  if (held && typeof held === 'object') {
    const r = held.refusal as { urgentLead?: unknown; actions?: unknown; hold?: unknown } | null | undefined;
    if (r && typeof r === 'object' && typeof r.urgentLead === 'string' && r.urgentLead) {
      push(r.urgentLead);
      for (const a of Array.isArray(r.actions) ? r.actions : []) push(a);
      for (const h of Array.isArray(r.hold) ? r.hold : []) push(h);
    } else {
      push(held.message);
    }
    push(held.footer);
  }
  const error = typeof b.error === 'string' ? b.error : '';
  if (
    b.footer ||
    error === 'app_restart_unavailable' ||
    error === 'permanently_excluded' ||
    (pending && error === 'finish_check_in')
  ) {
    push(b.message);
    push(b.footer);
  }
  if (lines.length > 0) push(b.eligibility);
  return lines.join('\n');
}

/** The content blocks of a tool result: the relay text first (ruling 453), then the text the tool returns. */
export function toolContent(text: string, body: unknown): { type: 'text'; text: string }[] {
  const relay = relayFirstText(body);
  return relay
    ? [
        {
          type: 'text',
          text: `Safety instructions: show these to the user first, word for word, before anything else.\n${relay}`,
        },
        { type: 'text', text },
      ]
    : [{ type: 'text', text }];
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
        return { content: toolContent(JSON.stringify(output, null, 2), output) };
      } catch (err) {
        // Item 1110 row 3: a lost response on a check-in, restart, correction or dose log is a structured unknown outcome, not a bare
        // error string. The original error stays in `error` (status 0 and its message), her text is `message`, and `saved` is null:
        // never true, never false.
        if (err instanceof UnknownOutcomeError) {
          const result = {
            outcome: err.outcome,
            saved: null,
            message: err.outcomeText,
            error: { status: err.status, message: err.message },
            readBack: err.readBack,
          };
          return {
            isError: true,
            structuredContent: result,
            content: [
              { type: 'text', text: err.outcomeText },
              { type: 'text', text: JSON.stringify(result, null, 2) },
            ],
          };
        }
        return {
          isError: true,
          content: toolContent(formatToolError(err), err instanceof ApiError ? err.body : null),
        };
      }
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  });

  return server;
}

/** Run the MCP server. Defaults to stdio; a transport can be injected for tests. */
export async function runMcpServer(transport?: Transport): Promise<void> {
  setClientTag('mcp');
  const server = buildMcpServer();
  await server.connect(transport ?? new StdioServerTransport());
}
