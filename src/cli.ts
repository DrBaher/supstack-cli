import { Command } from 'commander';
import { ZodError } from 'zod';

import { buildInput } from './args';
import { cachePath, clearCache } from './cache';
import type { AnyCapability } from './capability';
import { completionScript, isShell } from './completion';
import { warmCompletionCache } from './completion-data';
import { saveApiKey } from './config';
import { DISCLAIMER } from './constants';
import { exitCodeFor } from './exit-codes';
import { attachExamples } from './help-text';
import { ApiError } from './http';
import { cyan, dim, red } from './output';
import { capabilities } from './registry';
import { VERSION } from './version';

/**
 * Build a machine-readable error object for `--json` mode. Mirrors the human
 * branches in printError so scripts/agents can parse failures instead of
 * scraping prose. Emitted to stderr (stdout stays the data channel).
 */
export function errorToJson(err: unknown): { error: Record<string, unknown> } {
  if (err instanceof ZodError) {
    return {
      error: {
        type: 'invalid_input',
        message: 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.join('.') || '(input)', message: i.message })),
      },
    };
  }
  if (err instanceof ApiError) {
    return { error: { type: 'api_error', status: err.status, message: err.message } };
  }
  return { error: { type: 'error', message: (err as Error).message } };
}

export function printError(err: unknown, asJson = false): void {
  if (asJson) {
    process.stderr.write(JSON.stringify(errorToJson(err), null, 2) + '\n');
    return;
  }
  if (err instanceof ZodError) {
    process.stderr.write(red('Invalid input:') + '\n');
    for (const issue of err.issues) {
      const path = issue.path.join('.') || '(input)';
      process.stderr.write(`  ${path}: ${issue.message}\n`);
    }
    return;
  }
  if (err instanceof ApiError) {
    process.stderr.write(red(`API error (${err.status || 'network'}):`) + ` ${err.message}\n`);
    if (err.status === 401) {
      process.stderr.write(
        dim('  Hint: set a key with `supstack auth set-key <key>` or SUPSTACK_API_KEY.\n'),
      );
    } else if (err.status === 404) {
      process.stderr.write(
        dim('  Hint: check the slug/id — `supstack search <name>` lists valid supplement slugs.\n'),
      );
    } else if (err.status === 429) {
      process.stderr.write(
        dim('  Hint: rate limit hit (60/min). The client retries automatically; try again shortly.\n'),
      );
    }
    return;
  }
  process.stderr.write(red('Error:') + ` ${(err as Error).message}\n`);
}

async function runCapability(cap: AnyCapability, input: unknown, asJson: boolean): Promise<void> {
  const output = await cap.handler(input);
  if (asJson) {
    process.stdout.write(JSON.stringify(cap.format.json(output), null, 2) + '\n');
  } else {
    process.stdout.write(cap.format.text(output) + '\n');
  }
}

export function buildProgram(): Command {
  const program = new Command();
  // Throw on commander's own errors (unknown command/option, missing args) and
  // on --help/--version instead of calling process.exit itself. index.ts then
  // routes them through exitCodeFor, so CLI-misuse exits with the same
  // INVALID_INPUT (6) as a schema validation error — one consistent contract.
  program.exitOverride();
  program
    .name('supstack')
    .description('SupStack CLI — evidence-based supplement intelligence')
    .version(VERSION, '-v, --version')
    .option('--json', 'output raw JSON')
    .option('--no-cache', 'bypass the local response cache')
    .option('--timeout <seconds>', 'per-request timeout in seconds (default 20)')
    .option('--color', 'force ANSI colour (even when piped)')
    .option('--no-color', 'disable ANSI colour (also honours NO_COLOR / FORCE_COLOR)')
    .option('-q, --quiet', 'suppress the update-available notice');

  for (const cap of capabilities) {
    const signature = cap.cli.args ? `${cap.cli.command} ${cap.cli.args}` : cap.cli.command;
    const cmd = program.command(signature).description(cap.description);
    for (const opt of cap.cli.options ?? []) {
      cmd.option(opt.flags, opt.description, opt.defaultValue);
    }
    // Per-command flags so both `supstack --json define x` and `supstack define x --json` work.
    cmd.option('--json', 'output raw JSON');
    cmd.option('--no-cache', 'bypass the local response cache');
    cmd.option('--timeout <seconds>', 'per-request timeout in seconds (default 20)');
    attachExamples(cmd, cap.cli.command);
    cmd.action(async (...actionArgs: unknown[]) => {
      const options = actionArgs[actionArgs.length - 2] as Record<string, unknown>;
      const positionals = actionArgs.slice(0, actionArgs.length - 2);
      const asJson = Boolean(options.json) || Boolean(program.opts().json);
      // commander maps --no-cache to `cache: false`; signal it to the HTTP layer.
      if (options.cache === false || program.opts().cache === false) {
        process.env.SUPSTACK_NO_CACHE = '1';
      }
      // --timeout <seconds> → SUPSTACK_TIMEOUT, read by the HTTP layer.
      const timeout = options.timeout ?? program.opts().timeout;
      if (timeout !== undefined) process.env.SUPSTACK_TIMEOUT = String(timeout);
      try {
        const input = buildInput(cap, positionals, options);
        await runCapability(cap, input, asJson);
      } catch (err) {
        printError(err, asJson);
        process.exitCode = exitCodeFor(err);
      }
    });
  }

  // Run as an MCP server (stdio). mcp.ts is lazy-imported so non-mcp commands
  // don't pay the MCP SDK's module-load cost at startup.
  program
    .command('mcp')
    .description('Run as an MCP server (stdio) exposing all capabilities as tools')
    .action(async () => {
      const { runMcpServer } = await import('./mcp');
      await runMcpServer();
    });

  // Account auth (Phase 2). auth.ts is lazy-imported so read-only commands don't
  // pay for it at startup.
  program
    .command('login')
    .description('Sign in to your SupStack account (device authorization)')
    .action(async () => {
      const { runLogin } = await import('./auth');
      await runLogin();
    });
  program
    .command('logout')
    .description("Sign out and revoke this device's token")
    .action(async () => {
      const { runLogout } = await import('./auth');
      await runLogout();
    });
  program
    .command('whoami')
    .description('Show the signed-in account')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runWhoami } = await import('./auth');
      await runWhoami(Boolean(opts.json) || Boolean(program.opts().json));
    });

  // Adherence tracking. `track log [supplement]` + `track adherence`.
  const track = program.command('track').description('Log doses and view adherence (requires login)');
  track
    .command('log [supplement]')
    .description('Log a dose (no supplement = your whole stack today)')
    .option('--block <block>', 'timing block: morning | breakfast | midday | dinner | bedtime')
    .option('--date <date>', 'date YYYY-MM-DD (default today)')
    .option('--skip', 'record as skipped instead of taken')
    .option('--json', 'output raw JSON')
    .action(async (supplement: string | undefined, opts: Record<string, unknown>) => {
      const { runTrackLog } = await import('./track');
      await runTrackLog(supplement, opts, Boolean(opts.json) || Boolean(program.opts().json));
    });
  track
    .command('adherence')
    .description('Show your adherence rate, streak, and per-supplement breakdown')
    .option('-d, --days <n>', 'window in days (default 30)')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runAdherence } = await import('./track');
      const days = Math.min(365, Math.max(1, Number(opts.days) || 30));
      await runAdherence(days, Boolean(opts.json) || Boolean(program.opts().json));
    });

  // N-of-1 experiments (read). `experiments list` + `experiments show <id>`.
  const experiments = program
    .command('experiments')
    .description('View your N-of-1 experiments (requires login)');
  experiments
    .command('list')
    .description('List your experiments')
    .option('-s, --status <status>', 'filter: baseline | active | completed | abandoned')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runExperimentsList } = await import('./experiments');
      const status = typeof opts.status === 'string' ? opts.status : undefined;
      await runExperimentsList(status, Boolean(opts.json) || Boolean(program.opts().json));
    });
  experiments
    .command('show <id>')
    .description('Show one experiment (protocol, verdict, check-ins)')
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentShow } = await import('./experiments');
      await runExperimentShow(id, Boolean(opts.json) || Boolean(program.opts().json));
    });

  // Personalized recommendations from the user's saved goals + cloud stack.
  program
    .command('recommend')
    .description('Personalized supplement recommendations (requires login)')
    .option('-n, --limit <n>', 'max results (default 10)')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runRecommend } = await import('./recommend');
      const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
      await runRecommend(limit, Boolean(opts.json) || Boolean(program.opts().json));
    });

  // Health profile (requires login). `profile` shows; `profile set` updates.
  const profile = program
    .command('profile')
    .description('View your health profile (requires login)')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runProfileShow } = await import('./profile');
      await runProfileShow(Boolean(opts.json) || Boolean(program.opts().json));
    });
  profile
    .command('set')
    .description('Update your health profile')
    .option('--age <years>', 'age (13–120)')
    .option('--sex <sex>', 'biological sex: male | female')
    .option('--weight <value>', 'weight (0–1000)')
    .option('--weight-unit <unit>', 'kg | lbs')
    .option('--conditions <list>', 'comma-separated health conditions')
    .option('--medications <list>', 'comma-separated medications')
    .option('--goals <list>', 'comma-separated goal ids')
    .option('--current-supplements <list>', 'comma-separated supplement slugs you take')
    .option('--sleep-hours <n>', 'average nightly sleep hours (0–24)')
    .option('--exercise <freq>', 'exercise frequency: none | 1-2 | 3-4 | 5+')
    .option('--diet <type>', 'diet: omnivore | vegetarian | vegan | keto | paleo | mediterranean | other')
    .option('--stress <level>', 'stress level: low | moderate | high | very-high')
    .option('--tracks-bloodwork', 'mark that you track bloodwork')
    .option('--json', 'output raw JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { runProfileSet } = await import('./profile');
      await runProfileSet(opts, Boolean(opts.json) || Boolean(program.opts().json));
    });
  profile
    .command('clear')
    .description('Delete your health profile')
    .action(async () => {
      const { runProfileClear } = await import('./profile');
      await runProfileClear();
    });

  // API-key management (anonymous/manual keys, distinct from account login).
  const auth = program.command('auth').description('Manage API credentials');
  auth
    .command('set-key <key>')
    .description('Save an API key to ~/.supstack/config.json')
    .action((key: string) => {
      const path = saveApiKey(key);
      process.stdout.write(`Saved API key to ${path}\n`);
    });

  // Local response cache maintenance.
  const cache = program.command('cache').description('Manage the local response cache');
  cache
    .command('clear')
    .description('Delete all cached API responses')
    .action(() => {
      const n = clearCache();
      process.stdout.write(`Cleared ${n} cached response${n === 1 ? '' : 's'} from ${cachePath()}\n`);
    });
  cache
    .command('path')
    .description('Print the cache directory path')
    .action(() => {
      process.stdout.write(`${cachePath()}\n`);
    });

  // Shell completion: `completion <shell>` prints the script; `completion refresh`
  // warms the dynamic-value cache (supplement slugs + goal ids).
  program
    .command('completion [shell]')
    .description('Print a shell completion script (bash | zsh | fish), or `refresh` the value cache')
    .action(async (shell?: string) => {
      if (shell === 'refresh') {
        const counts = await warmCompletionCache();
        process.stdout.write(
          dim('Refreshed completion cache: ') +
            `${cyan(String(counts.supplements))} supplements, ${cyan(String(counts.goals))} goals\n`,
        );
        return;
      }
      const target = shell ?? process.env.SHELL?.split('/').pop() ?? 'bash';
      if (!isShell(target)) {
        process.stderr.write(red(`Unsupported shell: ${target}`) + ' (expected bash, zsh, or fish)\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(completionScript(target));
    });

  // Attach usage examples to the hand-built subcommands. (Registry commands get
  // theirs in the loop above; this covers the account/track/experiments group.)
  const find = (parent: Command, name: string): Command | undefined =>
    parent.commands.find((c) => c.name() === name);
  const trackCmd = find(program, 'track');
  if (trackCmd) {
    const log = find(trackCmd, 'log');
    if (log) attachExamples(log, 'track log');
    const adherence = find(trackCmd, 'adherence');
    if (adherence) attachExamples(adherence, 'track adherence');
  }
  const expCmd = find(program, 'experiments');
  if (expCmd) {
    const list = find(expCmd, 'list');
    if (list) attachExamples(list, 'experiments list');
    const show = find(expCmd, 'show');
    if (show) attachExamples(show, 'experiments show');
  }
  const recommendCmd = find(program, 'recommend');
  if (recommendCmd) attachExamples(recommendCmd, 'recommend');
  const profileCmd = find(program, 'profile');
  if (profileCmd) {
    const set = find(profileCmd, 'set');
    if (set) attachExamples(set, 'profile set');
  }

  program.addHelpText(
    'after',
    '\n' +
      dim('Docs: https://supstack.me/api  ·  Anonymous calls are rate-limited to 60/min.') +
      '\n\n' +
      dim(DISCLAIMER),
  );

  return program;
}
