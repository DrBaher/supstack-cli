import { buildProgram, printError } from './cli';
import { checkForUpdate } from './update';

async function main(): Promise<void> {
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
  printError(err, process.argv.includes('--json'));
  process.exit(1);
});
