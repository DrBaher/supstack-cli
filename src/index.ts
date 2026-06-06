import { CommanderError } from 'commander';

import { buildProgram, printError } from './cli';
import { exitCodeFor } from './exit-codes';
import { setColorOverride } from './output';
import { checkForUpdate } from './update';

async function main(): Promise<void> {
  // Resolve --color/--no-color up front (before any output) and strip them from
  // argv so they work in any position without every command having to declare
  // them. Precedence handled in output.ts: override → NO_COLOR → FORCE_COLOR → TTY.
  for (let i = process.argv.length - 1; i >= 2; i--) {
    if (process.argv[i] === '--no-color') {
      setColorOverride(false);
      process.argv.splice(i, 1);
    } else if (process.argv[i] === '--color') {
      setColorOverride(true);
      process.argv.splice(i, 1);
    }
  }

  // Hidden completion path: dispatched BEFORE commander so arbitrary `--flags`
  // in the typed line aren't parsed as options. Prints candidates, then exits.
  if (process.argv[2] === '__complete') {
    const { runComplete } = await import('./complete');
    await runComplete(process.argv.slice(3));
    return;
  }

  await buildProgram().parseAsync(process.argv);

  // After the command completes, surface a once-a-day "update available" nudge.
  // Never for the long-lived MCP server (it owns stdio), machine output, or
  // when silenced. argv is scanned directly so per-command flags are honoured.
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet') || argv.includes('-q');
  if (!argv.includes('mcp') && !argv.includes('--json') && !quiet && process.stdout.isTTY) {
    await checkForUpdate();
  }
}

main().catch((err: unknown) => {
  // Hand-registered authed commands (login/profile/recommend/experiments/track/…)
  // throw up to here; route through the same formatter the registry commands use
  // so errors are clean, carry the 401 hint, and are machine-readable in --json.
  // CommanderError (usage errors, --help, --version) already printed its own
  // message/help text, so don't re-print it — just map it to an exit code.
  if (!(err instanceof CommanderError)) {
    printError(err, process.argv.includes('--json'));
  }
  process.exit(exitCodeFor(err));
});
