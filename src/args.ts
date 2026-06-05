import type { AnyCapability } from './capability';

/** Reserved option names that are CLI-only and must not reach a capability's input schema. */
const RESERVED_OPTIONS = new Set(['json', 'cache']);

/** Extract positional arg names from a commander args string, e.g. `<a> [b...]` → ['a', 'b']. */
export function parseArgNames(args?: string): string[] {
  if (!args) return [];
  const matches = args.match(/[<[]([^>\]]+)[>\]]/g) ?? [];
  return matches.map((m) => m.slice(1, -1).replace(/\.\.\.$/, ''));
}

/**
 * Build a capability's validated input from commander's positionals + options.
 * Positionals are zipped onto the capability's arg names (a variadic positional
 * arrives as an array); reserved CLI flags (`--json`, `--no-cache`) are dropped.
 * Throws ZodError on invalid input.
 */
export function buildInput(
  cap: AnyCapability,
  positionals: unknown[],
  options: Record<string, unknown>,
): unknown {
  const raw: Record<string, unknown> = {};
  parseArgNames(cap.cli.args).forEach((name, i) => {
    raw[name] = positionals[i];
  });
  for (const [key, value] of Object.entries(options)) {
    if (RESERVED_OPTIONS.has(key)) continue;
    raw[key] = value;
  }
  return cap.inputSchema.parse(raw);
}
