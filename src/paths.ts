import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all CLI-local state (config, stack, cache). Override with SUPSTACK_HOME (tests). */
export function supstackHome(): string {
  return process.env.SUPSTACK_HOME ?? join(homedir(), '.supstack');
}

export function homePath(...segments: string[]): string {
  return join(supstackHome(), ...segments);
}

/**
 * Create a CLI-state directory with owner-only permissions (0700). `~/.supstack`
 * can hold an API key (`config.json` is written 0600); keeping the directory
 * itself private hardens against other local users listing/traversing it. The
 * chmod is best-effort and also repairs pre-existing 0755 dirs from older
 * installs (where mkdir alone wouldn't change perms). No-op on Windows.
 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not the owner / unusual fs — non-fatal.
    }
  }
  return dir;
}
