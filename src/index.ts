import { buildProgram } from './cli';
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
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
