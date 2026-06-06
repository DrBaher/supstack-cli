import { commandNames } from './completion';
import { loadCandidates } from './completion-data';
import { SUBCOMMANDS } from './help-text';

/**
 * Runtime completion engine behind the hidden `supstack __complete` command. The
 * shell scripts are dumb forwarders — they hand us every token typed after
 * `supstack` (the last element is the word being completed, possibly empty) and
 * we own all the logic here. One source of truth, testable in isolation.
 */

export type CompletionKind = 'commands' | 'sub' | 'supplements' | 'goals' | 'none';

export interface CompletionContext {
  kind: CompletionKind;
  /** The top-level command, when kind is 'sub'. */
  command?: string;
}

/** Commands whose positional args are supplement slugs, with the 1-based slug arg positions. */
const SLUG_POSITIONS: Record<string, 'all' | number[]> = {
  research: [1],
  compare: [1, 2, 3],
  interactions: 'all', // variadic
};

/** `<cmd> <action> <slug>` shapes — the slug is the 2nd positional. */
const ACTION_THEN_SLUG: Record<string, string[]> = {
  stack: ['add', 'remove'],
  track: ['log'],
};

/**
 * Decide what to complete from the tokens typed so far. `words` includes the
 * word under the cursor as its last element (may be ''). Flags are ignored for
 * positional counting, except `--goal`/`-g` which steers goal completion.
 */
export function completeContext(words: string[]): CompletionContext {
  const current = words[words.length - 1] ?? '';
  const prior = words.slice(0, -1);

  // First token → top-level command names.
  if (prior.length === 0) return { kind: 'commands' };

  // A value for --goal/-g (search) → goal ids.
  const prevToken = prior[prior.length - 1];
  if ((prevToken === '--goal' || prevToken === '-g') && prior[0] === 'search') {
    return { kind: 'goals' };
  }

  // Don't try to complete flag names as values.
  if (current.startsWith('-')) return { kind: 'none' };

  const command = prior[0];
  if (command === undefined) return { kind: 'none' };
  // Positionals typed so far (excluding the command itself and any flags/values).
  const positionals = prior.slice(1).filter((w) => !w.startsWith('-'));

  // Second token of a subcommand group → its actions (stack/track/experiments/…).
  if (positionals.length === 0 && SUBCOMMANDS[command]) {
    return { kind: 'sub', command };
  }

  // `<cmd> add|remove|log <slug>`.
  const actions = ACTION_THEN_SLUG[command];
  if (actions && positionals.length === 1 && positionals[0] !== undefined && actions.includes(positionals[0])) {
    return { kind: 'supplements' };
  }

  // Commands whose positionals are slugs.
  const slugPos = SLUG_POSITIONS[command];
  if (slugPos === 'all') return { kind: 'supplements' };
  if (Array.isArray(slugPos) && slugPos.includes(positionals.length + 1)) {
    return { kind: 'supplements' };
  }

  return { kind: 'none' };
}

/**
 * Resolve and prefix-filter completion candidates for a typed command line.
 * Never throws — the hidden command wraps this and prints nothing on error.
 */
export async function resolveCompletions(
  words: string[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const ctx = completeContext(words);
  const current = words[words.length - 1] ?? '';

  let candidates: string[];
  switch (ctx.kind) {
    case 'commands':
      candidates = commandNames();
      break;
    case 'sub':
      candidates = SUBCOMMANDS[ctx.command as string] ?? [];
      break;
    case 'supplements':
      candidates = await loadCandidates('supplements', { fetchImpl: opts.fetchImpl });
      break;
    case 'goals':
      candidates = await loadCandidates('goals', { fetchImpl: opts.fetchImpl });
      break;
    default:
      candidates = [];
  }

  return candidates.filter((c) => c.startsWith(current));
}

/**
 * Entry point for the hidden `__complete` path (dispatched in [index.ts](index.ts)
 * before commander, so arbitrary `--flags` in the typed line aren't parsed as
 * options). Prints newline-separated candidates; swallows every error and never
 * mints an anon key — completion must be silent and side-effect-free.
 */
export async function runComplete(words: string[]): Promise<void> {
  process.env.SUPSTACK_NO_ANON_TOKEN = '1';
  try {
    const results = await resolveCompletions(words);
    if (results.length) process.stdout.write(results.join('\n') + '\n');
  } catch {
    // Never disrupt the shell.
  }
}
