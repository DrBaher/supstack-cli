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
import { bold, cyan, dim, red } from './output';
import { capabilities } from './registry';
import { networkLossText, UnknownOutcomeError } from './unknown-outcome';
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
    // Pharmacist ruling 412 (10 October 2026): the eligibility rule survives --json.
    const eligibility =
      err.body && typeof err.body === 'object'
        ? (err.body as { eligibility?: unknown }).eligibility
        : undefined;
    // Pharmacist ruling 444 and 451 (12 October 2026): the footer survives --json too.
    const footer =
      err.body && typeof err.body === 'object' ? (err.body as { footer?: unknown }).footer : undefined;
    return {
      error: {
        type: 'api_error',
        status: err.status,
        message: err.message,
        ...(typeof eligibility === 'string' ? { eligibility } : {}),
        ...(typeof footer === 'string' ? { footer } : {}),
        // Item 1110 row 3: a lost response is neither saved nor failed. The original status and message stay.
        ...(err instanceof UnknownOutcomeError
          ? { outcome: err.outcome, outcomeMessage: err.outcomeText, readBack: err.readBack }
          : {}),
      },
    };
  }
  return { error: { type: 'error', message: (err as Error).message } };
}

/** Ruling 505: the structured app-hold refusal of an API error body, when it carries one. */
export function appHoldRefusalOf(
  body: unknown,
): { urgentLead: string; actions: string[]; hold: string[] } | null {
  if (!body || typeof body !== 'object') return null;
  const r = (body as { refusal?: unknown }).refusal;
  if (!r || typeof r !== 'object') return null;
  const x = r as { urgentLead?: unknown; actions?: unknown; hold?: unknown };
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  if (typeof x.urgentLead !== 'string' || !x.urgentLead) return null;
  return { urgentLead: x.urgentLead, actions: strings(x.actions), hold: strings(x.hold) };
}

function appHoldErrorCode(body: unknown): string {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : 'refused';
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
    // Pharmacist ruling 505 (14 October 2026): "Action first. Put a conditional
    // urgent-action paragraph first. Follow with dose advice and a separate
    // explanation of the app hold ... line breaks and an urgent heading where
    // supported." A refusal that carries `refusal` prints her urgent lead as a
    // bold red heading, each action as its own paragraph, then the hold, and
    // only then the API error line, so nothing administrative comes first.
    const refusal = appHoldRefusalOf(err.body);
    if (refusal) {
      process.stderr.write(bold(red(refusal.urgentLead)) + '\n');
      for (const a of refusal.actions) process.stderr.write(`\n${a}\n`);
      for (const h of refusal.hold) process.stderr.write(`\n${h}\n`);
    }
    // Pharmacist rulings 444 and 451 (12 October 2026): a refusal's footer
    // ("Follow the urgent instructions above"), directly under its message
    // (under the refusal's hold paragraph, ruling 505, before the error line).
    const footer =
      err.body && typeof err.body === 'object' ? (err.body as { footer?: unknown }).footer : undefined;
    if (refusal) {
      if (typeof footer === 'string' && footer) process.stderr.write(`\n${footer}\n`);
      process.stderr.write(
        '\n' + red(`API error (${err.status || 'network'}):`) + ` ${appHoldErrorCode(err.body)}\n`,
      );
    } else {
      process.stderr.write(red(`API error (${err.status || 'network'}):`) + ` ${err.message}\n`);
      if (typeof footer === 'string' && footer) process.stderr.write(`  ${footer}\n`);
    }
    // Item 1110 row 3 (her item 750 text, verbatim): after the error line, for a timeout or network error on a check-in, restart or correction.
    if (err instanceof UnknownOutcomeError) process.stderr.write(`${err.outcomeText}\n`);
    // Item 1110 row 12: any other lost connection says what it is, by whether the request was a read or a submitted update.
    else if (networkLossText(err)) process.stderr.write(`${networkLossText(err)}\n`);
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

  // N-of-1 experiments. Read (list/show/protocol) + write (start/check-in).
  const experiments = program
    .command('experiments')
    .description('Run your N-of-1 experiments — list, start, check-in (requires login)');
  const collectAnswer = (v: string, acc: string[]): string[] => [...acc, v];
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
  experiments
    .command('protocol <supplement> <goal>')
    .description('Preview the baseline + check-in questions for a supplement × goal')
    .option('--json', 'output raw JSON')
    .action(async (supplement: string, goal: string, opts: Record<string, unknown>) => {
      const { runExperimentProtocol } = await import('./experiments');
      await runExperimentProtocol(supplement, goal, Boolean(opts.json) || Boolean(program.opts().json));
    });
  experiments
    .command('start <supplement> <goal>')
    .description('Start an experiment (no --answer shows the questions to answer)')
    .option('-a, --answer <id=value>', 'baseline answer (repeatable)', collectAnswer, [])
    .option(
      '--prestart-review <json>',
      'a review record that releases a review-before-start gate, as JSON (repeatable; your own account, not verified)',
      collectAnswer,
      [],
    )
    .option(
      '--restart-record <json>',
      'the restart record of an earlier experiment with this supplement that ended while paused for safety, as JSON (your own account, not verified)',
    )
    .option('--json', 'output raw JSON')
    .action(async (supplement: string, goal: string, opts: Record<string, unknown>) => {
      const { runExperimentStart } = await import('./experiments');
      const answers = Array.isArray(opts.answer) ? (opts.answer as string[]) : [];
      const reviews = Array.isArray(opts.prestartReview) ? (opts.prestartReview as string[]) : [];
      await runExperimentStart(
        supplement,
        goal,
        answers,
        Boolean(opts.json) || Boolean(program.opts().json),
        reviews,
        typeof opts.restartRecord === 'string' ? opts.restartRecord : undefined,
      );
    });
  experiments
    .command('check-in <id>')
    .description('Submit a check-in (no --answer shows the questions to answer)')
    .option('-a, --answer <id=value>', 'check-in answer (repeatable)', collectAnswer, [])
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentCheckIn } = await import('./experiments');
      const answers = Array.isArray(opts.answer) ? (opts.answer as string[]) : [];
      await runExperimentCheckIn(id, answers, Boolean(opts.json) || Boolean(program.opts().json));
    });
  experiments
    .command('report <id>')
    .description('Report a symptom or safety concern at any time (no --answer shows the safety questions)')
    .option('-a, --answer <id=value>', 'safety answer (repeatable)', collectAnswer, [])
    .option('--clarify <reportNumber:questionId>', 'clarify one earlier saved answer (pharmacist ruling 705)')
    .option('--kind <kind>', 'with --clarify: situation-changed (default) or entered-by-mistake')
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentReport } = await import('./experiments');
      const answers = Array.isArray(opts.answer) ? (opts.answer as string[]) : [];
      await runExperimentReport(
        id,
        answers,
        Boolean(opts.json) || Boolean(program.opts().json),
        typeof opts.clarify === 'string'
          ? { raw: opts.clarify, ...(typeof opts.kind === 'string' ? { kind: opts.kind } : {}) }
          : undefined,
      );
    });
  experiments
    .command('correct <id>')
    .description('Correct a check-in answer chosen by mistake, submitted or not (not a clinical review)')
    .option(
      '-c, --check-in <n>',
      'the check-in that paused it (submitted, or the one being answered)',
      (v: string) => Number(v),
    )
    .option(
      '--report <n>',
      'an answer saved in this safety report (pharmacist ruling 706), instead of --check-in',
      (v: string) => Number(v),
    )
    .option(
      '-a, --answer <id=value>',
      'the answer you give now, for every answer that paused it (repeatable)',
      collectAnswer,
      [],
    )
    .option(
      '-s, --screen <id=value>',
      'the screen answered again: warning signs and pregnancy status (repeatable)',
      collectAnswer,
      [],
    )
    .option('--affirm', 'you affirm you chose it by mistake and none of it happened or is happening now')
    .option(
      '--event <id>',
      'only this open safety event (repeatable); other events stay open and keep the pause',
      collectAnswer,
      [],
    )
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentCorrect } = await import('./experiments');
      await runExperimentCorrect(
        id,
        {
          checkIn: typeof opts.checkIn === 'number' ? opts.checkIn : undefined,
          ...(typeof opts.report === 'number' ? { report: opts.report } : {}),
          answers: Array.isArray(opts.answer) ? (opts.answer as string[]) : [],
          screen: Array.isArray(opts.screen) ? (opts.screen as string[]) : [],
          affirm: opts.affirm === true,
          eventIds: Array.isArray(opts.event) ? (opts.event as string[]) : [],
        },
        Boolean(opts.json) || Boolean(program.opts().json),
      );
    });
  experiments
    .command('clarify-status <id>')
    .description('Release a status hold with a definite pregnancy status (no --screen shows the questions)')
    .option(
      '-s, --screen <id=value>',
      'the screen answered again: warning signs and pregnancy status (repeatable)',
      collectAnswer,
      [],
    )
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentClarifyStatus } = await import('./experiments');
      const screen = Array.isArray(opts.screen) ? (opts.screen as string[]) : [];
      await runExperimentClarifyStatus(id, screen, Boolean(opts.json) || Boolean(program.opts().json));
    });
  experiments
    .command('restart <id>')
    .description(
      'Restart an experiment paused for safety, with the restart record (no --screen shows what it needs)',
    )
    .option(
      '-s, --screen <id=value>',
      'the screen answered again: warning signs, pregnancy and breastfeeding status (repeatable)',
      collectAnswer,
      [],
    )
    .option('--reviewer <role>', 'who reviewed it: doctor, pharmacist, nurse, midwife or other-clinician')
    .option('--reviewed-on <date>', 'the date of the review, YYYY-MM-DD')
    .option('--dose <text>', 'the product and dose you restart with')
    .option('--form <text>', 'the product form (capsule, powder, liquid ...)')
    .option('--plan <text>', 'the restart plan you agreed (for a timing pause, the agreed schedule)')
    .option(
      '--serious-injury <decision>',
      'what the clinician concluded about a serious reaction to this product: excluded (ruled out), confirmed, suspected-or-unresolved (still suspected, or the assessment is not complete) or not-discussed (not assessed, or you do not know). Pharmacist ruling 354: only excluded can restart, every other answer is held whatever the clearance',
    )
    .option(
      '--serious-illness <decision>',
      'what the clinician concluded about the serious illness or injury itself: excluded, confirmed, suspected-or-unresolved or not-discussed. Pharmacist ruling 355: not-discussed is held until assessed, confirmed needs the clinician to have assessed it as resolved or stable with documented clearance, suspected-or-unresolved needs that and --illness-assessment-complete. With more than one named illness, repeat as <illness>=<decision>',
      collectAnswer,
      [],
    )
    .option(
      '--applies-to-all',
      'one --serious-illness answer applies to EVERY illness the pause names (you saw the full list)',
    )
    .option(
      '--sjs-ten <answer>',
      'a serious skin reaction, what the clinician concluded: confirmed-culprit (never restarted), ruled-out, suspected or not-assessed (both stay excluded pending specialist assessment)',
    )
    .option(
      '--plan-file <path>',
      'a JSON file with the pregnancy and/or breastfeeding plan(s) (populationPlans)',
    )
    .option(
      '--current-regimen-file <path>',
      'a JSON file with the exact regimen you restart on (currentRegimen)',
    )
    .option(
      '--current-lactation-file <path>',
      'a JSON file with the current breastfeeding context (currentLactation)',
    )
    .option(
      '--resolution <state>',
      'whether the CLINICIAN assessed the illness or injury as resolved, stable or not-resolved (pharmacist ruling 356)',
    )
    .option(
      '--illness-assessment-complete',
      'only for a suspected illness: the clinician completed a safety assessment and documented that this exact product may be restarted despite the uncertain diagnosis (pharmacist ruling 355)',
    )
    .option(
      '--other-exposures <text>',
      'every other supplement, medicine or product you took at the time, or "none"',
    )
    .option('--clearance <text>', 'where the clinician documented the clearance (a serious event)')
    .option(
      '--maternity-assessed',
      'your maternity team assessed it (a pregnancy or breastfeeding pause or plan)',
    )
    .option('--pregnancy-plan <text>', 'the pregnancy or breastfeeding plan for this product, dose and form')
    .option('--advised', 'a clinician ADVISED you can restart this product, in this form and at this dose')
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentRestart, seriousIllnessFromFlags, planFilesFromFlags } =
        await import('./experiments');
      const str = (k: string) => (typeof opts[k] === 'string' ? (opts[k] as string) : undefined);
      await runExperimentRestart(
        id,
        {
          screen: Array.isArray(opts.screen) ? (opts.screen as string[]) : [],
          record: {
            reviewerRole: str('reviewer'),
            reviewedOn: str('reviewedOn'),
            dose: str('dose'),
            productForm: str('form'),
            restartPlan: str('plan'),
            seriousInjury: str('seriousInjury'),
            ...seriousIllnessFromFlags(
              Array.isArray(opts.seriousIllness) ? (opts.seriousIllness as string[]) : [],
            ),
            ...(opts.appliesToAll === true ? { seriousIllnessAppliesToAll: true } : {}),
            sjsTen: str('sjsTen'),
            ...planFilesFromFlags({
              planFile: str('planFile'),
              currentRegimenFile: str('currentRegimenFile'),
              currentLactationFile: str('currentLactationFile'),
            }),
            eventResolution: str('resolution'),
            ...(opts.illnessAssessmentComplete === true ? { illnessAssessmentComplete: true } : {}),
            otherExposures: str('otherExposures'),
            clearanceReference: str('clearance'),
            ...(opts.maternityAssessed === true ? { maternityAssessed: true } : {}),
            pregnancyPlan: str('pregnancyPlan'),
            clinicianAdvisedRestart: opts.advised === true,
          },
        },
        Boolean(opts.json) || Boolean(program.opts().json),
      );
    });
  experiments
    .command('abandon <id>')
    .description('Stop an in-progress experiment (no verdict)')
    .option('--yes', 'end it now (without it, the effect of ending is shown and nothing changes)')
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: Record<string, unknown>) => {
      const { runExperimentAbandon } = await import('./experiments');
      await runExperimentAbandon(id, Boolean(opts.json) || Boolean(program.opts().json), opts.yes === true);
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
    .option('--weight <value>', 'weight (0–1000; stored for your records — nothing computes a dose from it)')
    .option('--weight-unit <unit>', 'kg | lbs')
    .option('--conditions <list>', 'comma-separated health conditions')
    .option('--medications <list>', 'comma-separated medications')
    .option('--goals <list>', 'comma-separated goal ids')
    .option('--current-supplements <list>', 'comma-separated supplement slugs you take')
    .option('--sleep-hours <n>', 'average nightly sleep hours (0–24)')
    .option('--exercise <freq>', 'exercise frequency: none | 1-2 | 3-4 | 5+')
    .option('--diet <type>', 'diet: omnivore | vegetarian | vegan | keto | paleo | mediterranean | other')
    .option('--stress <level>', 'stress level: low | moderate | high | very-high')
    .option('--smoking <status>', 'smoking status: never | former | current (gates beta-carotene)')
    .option(
      '--enzyme-allergy <list>',
      'enzymes that caused an allergic reaction (lactase, bromelain, papain, trypsin, ... or unknown); replaces the stored list, none clears',
    )
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

  // Shell completion: `completion <shell>` prints the script; `completion install`
  // wires it into your shell; `completion refresh` warms the dynamic-value cache.
  program
    .command('completion [action]')
    .description(
      'Shell completion: print a script (bash|zsh|fish), `install`/`uninstall` it, or `refresh` the cache',
    )
    .action(async (action?: string) => {
      if (action === 'refresh') {
        const counts = await warmCompletionCache();
        process.stdout.write(
          dim('Refreshed completion cache: ') +
            `${cyan(String(counts.supplements))} supplements, ${cyan(String(counts.goals))} goals\n`,
        );
        return;
      }
      if (action === 'install' || action === 'uninstall') {
        const detected = process.env.SHELL?.split('/').pop() ?? '';
        if (!isShell(detected)) {
          process.stderr.write(
            red(`Could not detect your shell from $SHELL (got "${detected || 'empty'}").`) +
              ' Print the script directly instead: `supstack completion <bash|zsh|fish>`.\n',
          );
          process.exitCode = 1;
          return;
        }
        const { installCompletion, uninstallCompletion } = await import('./completion-install');
        if (action === 'uninstall') {
          const { removed } = uninstallCompletion(detected);
          process.stdout.write(
            removed.length
              ? `Removed ${detected} completion:\n` + removed.map((r) => `  ${dim(r)}`).join('\n') + '\n'
              : dim(`Nothing to remove for ${detected}.\n`),
          );
          return;
        }
        const r = installCompletion(detected);
        const lines = [
          r.alreadyWired ? `${detected} completion already installed.` : `Installed ${detected} completion.`,
          `  script: ${dim(r.scriptPath)}`,
          ...(r.rcPath ? [`  wired:  ${dim(r.rcPath)}`] : []),
          dim(`Activate it now: ${r.reload}`),
          dim('Pre-warm slug/goal completion with: supstack completion refresh'),
        ];
        process.stdout.write(lines.join('\n') + '\n');
        return;
      }
      const target = action ?? process.env.SHELL?.split('/').pop() ?? 'bash';
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
    for (const sub of [
      'protocol',
      'start',
      'check-in',
      'correct',
      'clarify-status',
      'restart',
      'abandon',
    ] as const) {
      const c = find(expCmd, sub);
      if (c) attachExamples(c, `experiments ${sub}`);
    }
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
