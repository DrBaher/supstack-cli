import { compare } from './capabilities/compare';
import { define } from './capabilities/define';
import { exportStack } from './capabilities/export';
import { interactions } from './capabilities/interactions';
import { research } from './capabilities/research';
import { search } from './capabilities/search';
import { stack } from './capabilities/stack';
import { studies } from './capabilities/studies';
import type { AnyCapability } from './capability';

/**
 * The single source of truth for what the CLI and the MCP server can do.
 * Add a capability here and it appears in BOTH surfaces automatically.
 *
 * Phase 1 command grammar is complete. `define` is the reference implementation.
 */
export const capabilities: AnyCapability[] = [
  research,
  search,
  compare,
  studies,
  interactions,
  stack,
  exportStack,
  define,
];
