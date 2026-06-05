import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all CLI-local state (config, stack, cache). Override with SUPSTACK_HOME (tests). */
export function supstackHome(): string {
  return process.env.SUPSTACK_HOME ?? join(homedir(), '.supstack');
}

export function homePath(...segments: string[]): string {
  return join(supstackHome(), ...segments);
}
