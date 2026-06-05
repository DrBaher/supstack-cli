import { Command } from 'commander';
import { ZodError } from 'zod';

import { buildInput } from './args';
import { cachePath, clearCache } from './cache';
import type { AnyCapability } from './capability';
import { completionScript, isShell } from './completion';
import { saveApiKey } from './config';
import { DISCLAIMER } from './constants';
import { ApiError } from './http';
import { dim, red } from './output';
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

function printError(err: unknown, asJson = false): void {
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
  program
    .name('supstack')
    .description('SupStack CLI — evidence-based supplement intelligence')
    .version(VERSION, '-v, --version')
    .option('--json', 'output raw JSON')
    .option('--no-cache', 'bypass the local response cache')
    .option('--timeout <seconds>', 'per-request timeout in seconds (default 20)')
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
        process.exitCode = 1;
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

  // Shell completion script generator (bash | zsh | fish), derived from the registry.
  program
    .command('completion [shell]')
    .description('Print a shell completion script (bash | zsh | fish)')
    .action((shell?: string) => {
      const target = shell ?? process.env.SHELL?.split('/').pop() ?? 'bash';
      if (!isShell(target)) {
        process.stderr.write(red(`Unsupported shell: ${target}`) + ' (expected bash, zsh, or fish)\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(completionScript(target));
    });

  program.addHelpText(
    'after',
    '\n' +
      dim('Docs: https://supstack.me/api  ·  Anonymous calls are rate-limited to 60/min.') +
      '\n\n' +
      dim(DISCLAIMER),
  );

  return program;
}
