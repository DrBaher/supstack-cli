import type { Command } from 'commander';

import { dim } from './output';

/**
 * Sub-actions for the commands whose actions are NOT commander subcommands but a
 * single positional `<action>` arg (today only `stack`), PLUS the real
 * subcommand groups — so shell completion can offer them at position 2 from one
 * source of truth. Keyed by the top-level command. See [complete.ts](complete.ts).
 */
export const SUBCOMMANDS: Record<string, string[]> = {
  stack: ['add', 'remove', 'list', 'pull', 'push', 'sync'],
  track: ['log', 'adherence'],
  experiments: ['list', 'show'],
  profile: ['set', 'clear'],
  auth: ['set-key'],
  cache: ['clear', 'path'],
  completion: ['bash', 'zsh', 'fish', 'install', 'uninstall', 'refresh'],
};

/**
 * Usage examples per command, keyed by the full command path (space-joined).
 * Rendered after a command's `--help` so the option list stops being a puzzle —
 * especially for the variadic/multiplexed commands (`stack`, `interactions`) and
 * the option-heavy `profile set`.
 */
export const EXAMPLES: Record<string, string[]> = {
  research: ['supstack research magnesium', 'supstack research creatine --protocol --synergies'],
  search: [
    'supstack search ashwagandha',
    'supstack search --goal deep-sleep --evidence strong',
    'supstack search --category mineral --safety high --sort name',
  ],
  compare: ['supstack compare magnesium glycine', 'supstack compare creatine beta-alanine citrulline'],
  studies: ['supstack studies "vitamin d"', 'supstack studies --supplement magnesium --type meta-analysis'],
  interactions: [
    'supstack interactions magnesium zinc',
    'supstack interactions caffeine l-theanine ashwagandha --pathway',
  ],
  stack: [
    'supstack stack list',
    'supstack stack add magnesium',
    'supstack stack remove caffeine',
    'supstack stack sync        # merge local + cloud (requires login)',
  ],
  rate: [
    'supstack rate                              # your local stack, goals inferred',
    'supstack rate --goals deep-sleep,sharpen-focus',
    'supstack rate magnesium l-theanine creatine --goals build-strength',
    'supstack rate --cloud                      # your synced stack (requires login)',
  ],
  goals: ['supstack goals', 'supstack goals sleep', 'supstack goals --category mental'],
  export: ['supstack export', 'supstack export --json > my-stack.json'],
  define: ['supstack define bioavailability'],
  recommend: ['supstack recommend', 'supstack recommend --limit 5 --json'],
  'track log': [
    'supstack track log magnesium',
    'supstack track log              # log your whole stack for today',
    'supstack track log creatine --date 2026-06-01 --skip',
  ],
  'track adherence': ['supstack track adherence', 'supstack track adherence --days 7'],
  'experiments list': ['supstack experiments list', 'supstack experiments list --status active'],
  'experiments show': ['supstack experiments show 8b03297e   # full id or a unique prefix'],
  'profile set': [
    'supstack profile set --age 35 --sex male --weight 80 --weight-unit kg',
    'supstack profile set --goals deep-sleep,focus --sleep-hours 7 --exercise 3-4',
    'supstack profile set --conditions "hypertension" --medications "lisinopril"',
  ],
};

/** Build a dimmed "Examples:" block, or '' when there are none. */
export function examplesBlock(lines: string[] | undefined): string {
  if (!lines || lines.length === 0) return '';
  return '\n' + dim('Examples:') + '\n' + lines.map((l) => dim('  ' + l)).join('\n') + '\n';
}

/** Attach the registered examples (if any) to a command's `--help` output. */
export function attachExamples(cmd: Command, key: string): Command {
  const block = examplesBlock(EXAMPLES[key]);
  if (block) cmd.addHelpText('after', block);
  return cmd;
}
