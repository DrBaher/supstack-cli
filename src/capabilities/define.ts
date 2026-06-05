import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim } from '../output';

/** Response shape of GET /api/v1/definitions?term=... (the `data` envelope payload). */
export const DefinitionSchema = z.object({
  term: z.string(),
  definition: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Definition = z.infer<typeof DefinitionSchema>;

const InputSchema = z.object({
  term: z.string().min(1, 'A term is required, e.g. `supstack define bioavailability`'),
});

/**
 * Reference capability. Every other Phase 1 capability follows this exact shape:
 *   inputSchema → handler (hits the public API) → format.{text,json}
 * The CLI and MCP server are both generated from this definition.
 */
export const define = defineCapability({
  name: 'define',
  description: 'Look up a supplement-science glossary term',
  inputSchema: InputSchema,
  cli: {
    command: 'define',
    args: '<term>',
  },
  mcp: {
    toolName: 'supstack_define',
    description:
      'Define a supplement-science glossary term such as "bioavailability", "adaptogen", or "meta-analysis". Returns the definition and any aliases. Use when the user asks what a supplement or research term means.',
  },
  handler: async ({ term }): Promise<Definition> => {
    const res = await apiGet<{ data: unknown }>('/definitions', { query: { term } });
    return DefinitionSchema.parse(res.data);
  },
  format: {
    text: (d: Definition): string => {
      const lines = [bold(d.term), '', d.definition];
      if (d.aliases.length > 0) {
        lines.push('', dim(`Also known as: ${d.aliases.join(', ')}`));
      }
      return lines.join('\n');
    },
    json: (d: Definition): unknown => d,
  },
});
