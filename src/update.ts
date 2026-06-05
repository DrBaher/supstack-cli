import { readFileSync, writeFileSync } from 'node:fs';

import { dim } from './output';
import { ensureDir, homePath, supstackHome } from './paths';
import { VERSION } from './version';

/**
 * Lightweight "a newer version is available" nudge — no dependency on
 * `update-notifier` (which would pull dozens of transitive packages into a
 * deliberately 3-dependency CLI).
 *
 * Design:
 *   - Reads a cached `latest` from ~/.supstack/update-check.json and prints the
 *     nudge instantly (no network on the hot path).
 *   - Refreshes that cache from the npm registry at most once per 24h, behind a
 *     1.5s timeout so it can never delay or hang a command.
 *   - Silent for non-TTY, `--json`, `--quiet`, `mcp`, CI, and when opted out via
 *     SUPSTACK_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER.
 */

const CHECK_FILE = 'update-check.json';
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REGISTRY_URL = 'https://registry.npmjs.org/@supstack/cli/latest';

interface UpdateState {
  lastCheck: number;
  latest?: string;
}

function readState(): UpdateState {
  try {
    return JSON.parse(readFileSync(homePath(CHECK_FILE), 'utf8')) as UpdateState;
  } catch {
    return { lastCheck: 0 };
  }
}

function writeState(state: UpdateState): void {
  try {
    ensureDir(supstackHome());
    writeFileSync(homePath(CHECK_FILE), JSON.stringify(state));
  } catch {
    // Best-effort; never break a command over the update check.
  }
}

/** True if `a` is a strictly higher semver-ish (x.y.z, ignoring pre-release) than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

function nudge(latest: string): string {
  return dim(`\nUpdate available: ${VERSION} → ${latest}  ·  npm i -g @supstack/cli`);
}

export interface UpdateCheckDeps {
  fetchImpl?: typeof fetch;
  now?: number;
  /** Where the nudge is written. Defaults to process.stderr.write. */
  write?: (s: string) => void;
}

/**
 * Run the update check. Returns the nudge string if one was shown, else null.
 * Callers gate on context (TTY / command); this function handles env opt-outs,
 * the cache, and the throttled refresh.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<string | null> {
  if (process.env.SUPSTACK_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI) {
    return null;
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now();
  const write = deps.write ?? ((s: string): void => void process.stderr.write(s + '\n'));

  const state = readState();
  let shown: string | null = null;

  // Instant path: nudge from the last-known latest.
  if (state.latest && isNewerVersion(state.latest, VERSION)) {
    shown = nudge(state.latest);
    write(shown);
  }

  // Refresh at most once per day, time-boxed so it can never stall the CLI.
  if (now - state.lastCheck < THROTTLE_MS) return shown;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let latest: string | undefined;
    try {
      const res = await fetchImpl(REGISTRY_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => undefined)) as { version?: string } | undefined;
      latest = json?.version;
    } finally {
      clearTimeout(timer);
    }
    writeState({ lastCheck: now, latest: latest ?? state.latest });
    // If we hadn't already nudged from cache and the fresh value is newer, do it now.
    if (!shown && latest && isNewerVersion(latest, VERSION)) {
      shown = nudge(latest);
      write(shown);
    }
  } catch {
    // Network/timeout failure: just record the attempt so we don't retry hot.
    writeState({ ...state, lastCheck: now });
  }
  return shown;
}
