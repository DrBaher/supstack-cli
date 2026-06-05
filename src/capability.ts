import type { z } from 'zod';

/**
 * A single CLI option, expressed in commander's flag syntax.
 * e.g. `{ flags: '-c, --category <category>', description: 'Filter by category' }`
 */
export interface CliOption {
  flags: string;
  description: string;
  defaultValue?: string | boolean;
}

/**
 * The architectural heart of the SupStack CLI.
 *
 * Every capability is defined ONCE and exposed through multiple surfaces:
 *   - the CLI (commander iterates the registry → builds commands)
 *   - the MCP server (the MCP server iterates the same registry → builds tools)
 *
 * Same `inputSchema`, same `handler`, same `format`. The surfaces cannot drift
 * because they are generated from one definition. Adding a new capability is a
 * single file that gets pushed into the registry — both surfaces pick it up.
 */
export interface Capability<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  /** Internal id, kebab-case. */
  name: string;
  /** One-line human description (shown in CLI help). */
  description: string;
  /** Zod schema for validated input. Drives both CLI arg parsing and the MCP tool's JSON Schema. */
  inputSchema: I;
  cli: {
    /** The command verb, e.g. `define`. */
    command: string;
    /** commander positional-arg syntax, e.g. `<term>` or `<a> <b> [c]`. */
    args?: string;
    options?: CliOption[];
  };
  mcp: {
    toolName: string;
    /** Critical for agent tool selection — write this for an LLM reader, not a human. */
    description: string;
    /** True if the tool changes state (e.g. local stack). Drives the MCP `readOnlyHint`. */
    mutates?: boolean;
  };
  handler: (input: z.infer<I>) => Promise<O>;
  format: {
    /** Human-readable CLI output. */
    text: (output: O) => string;
    /** Machine output for `--json` and MCP tool results. */
    json: (output: O) => unknown;
  };
}

/**
 * Identity helper that preserves `I`/`O` inference at the definition site while
 * letting the registry store capabilities under a single erased type.
 */
export function defineCapability<I extends z.ZodTypeAny, O>(cap: Capability<I, O>): Capability<I, O> {
  return cap;
}

/**
 * The registry stores capabilities with their output type erased to `any`.
 * (A `Capability<_, Definition>` is not assignable to `Capability<_, unknown>`
 * because `format.text: (o: Definition) => string` is contravariant in `O`.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<z.ZodTypeAny, any>;
