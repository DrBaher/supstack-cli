import { readFileSync } from 'node:fs';

import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { heldCodeListText } from './held-code-text';
import { ApiError, apiGetAuthed, apiPost } from './http';
import { bold, cyan, dim, green, red, yellow } from './output';
import { withUnknownOutcome } from './unknown-outcome';

export interface ExperimentListItem {
  id: string;
  supplement: { slug: string; name: string };
  /**
   * ⚠️ Round 94 of the human persona audit. `/me/experiments` returns the
   * caller's CURRENT verdict for this supplement — "as of now, not as of when
   * it started" — and this type omitted the field, so it was parsed away.
   *
   * `getExperiments` feeds `mcp-authed.ts`, so the loser was not only the
   * terminal: a model asked for someone's active experiments relayed the list
   * with the contraindication silently missing. Round 93 was the same defect on
   * the stack endpoint; this is the second endpoint, which is why round 94's
   * test sweeps the CLI's types against the API's shapes rather than fixing
   * them one at a time.
   */
  safety: {
    level: 'block' | 'warn' | 'unrecognised' | 'unchecked';
    risks: string[];
    uncheckedAxes?: string[];
  } | null;
  goal: { id: string; name: string };
  status: string;
  verdict: string | null;
  verdictSummary: string | null;
  progress: { completed: number; expected: number };
  /**
   * Owner call O-6 (14 October 2026): true on a paused experiment whose
   * restart the app refuses whatever record is sent. `heldReason` carries the
   * refusal's machine codes only; `experiments show` prints its text.
   */
  held?: boolean;
  heldReason?: { error: string; holdState?: string; productWide?: true };
  startedAt: string | null;
  completedAt: string | null;
  nextCheckInDate: string | null;
}

/**
 * Owner ruling 192.1: the safety action a check-in's answers triggered. The
 * API sends it on the check-in response and on the experiment detail, and it
 * is printed FIRST, before the routine "check-in recorded" line. `pauses` means
 * the experiment is paused: no next check-in, no next dose, and a restart needs
 * a clinician to have reviewed the symptoms.
 */
export interface SafetyAction {
  /** Pharmacist ruling 628: the experiment ended while this pause stood (her W628 note, under her W628 heading). */
  endedNote?: string;
  /** Pharmacist ruling 653: the rest of her W653, after the event action. */
  endedTail?: string;
  /** Item 756 (R4-03): the escalation warnings an urgent top action would hide with a monitoring instruction, under her heading. */
  otherWarnings?: { heading: string; text: string };
  /**
   * `hold` (pharmacist ruling 239): a status hold before the next dose, after
   * "I might be pregnant" or not being sure. Not a safety pause and not an
   * event: a definite answer releases it (`supstack experiments clarify-status`).
   */
  category: 'monitor' | 'contact' | 'hold' | 'pause-clinician' | 'pause-urgent' | 'emergency';
  /** Ruling 239: the check-in holds the next dose on a status hold, and nothing pauses. */
  statusHold?: boolean;
  /**
   * Pharmacist ruling 221 call 3: the heading, derived by the server from the
   * instruction's destination and urgency. Printed as it is, so the terminal
   * shows the same heading as the web and the assistant.
   */
  heading?: string;
  destination?: string;
  urgency?: string;
  /** Ruling 221 calls 5, 8 and 9: the serious injury a clinician-advised restart must record as ruled out. */
  restartMustRecordExcluded?: string[];
  /** Ruling 280: the dedicated plans a restart of this pause needs, and whether it is a plan pause only. */
  populationPlansRequired?: ('pregnancy' | 'lactation')[];
  planOnly?: boolean;
  pauses: boolean;
  /** Pharmacist ruling 198: a baseline answer that stops the experiment starting. */
  blocksStart?: boolean;
  restartNeedsClinicianReview: boolean;
  /** What a restart needs: a clinician's advice, a documented clearance (serious events) or an agreed schedule (timing). */
  restartRequires?: 'pharmacist-schedule' | 'clinician-advised' | 'documented-clearance' | null;
  instruction: string;
  /**
   * The footer (pharmacist ruling 444): under a pause her paused-experiment
   * footer, under a blocked start her pre-start footer. Printed directly under
   * the instructions it refers to ("Follow the urgent instructions above").
   */
  note?: string;
  /** Ruling 444: her shared pause status note, sent by the server with every pause. */
  pauseStatusNote?: string;
  /** Ruling 444: her short restart explanation, sent with every pause that names a restart requirement. */
  restartPlanNote?: string;
  /** Ruling 507: the restart requirement in the web's words, from the server's shared source. */
  restartRequirementText?: string;
  /** Ruling 568: the version of that text, printed and kept with it. */
  restartRequirementTextVersion?: string;
  checkInNumber: number | null;
  /**
   * `notSure`: the user answered "not sure". Since pharmacist ruling 198 it
   * follows the question: emergency on a red flag, a pause on an urgent sign,
   * a precaution only on a mild one. `redFlag`: an emergency screening question.
   */
  actions: {
    questionId: string;
    answer: string;
    category: string;
    urgency?: string;
    instruction: string;
    notSure?: boolean;
    redFlag?: boolean;
    needsRecord?: string;
  }[];
  /**
   * Pharmacist ruling 208, call 4: the review records the start still needs.
   * An answer alone never releases a gate: resubmit with `--prestart-review`.
   */
  preStartRecordsNeeded?: string[];
}

/**
 * Pharmacist ruling 507 (14 October 2026): "Align the CLI with the same
 * versioned restart text, including that the experiment stays stopped until
 * the conditions are met. Use the shared source of truth and the same hold
 * states." The CLI prints the server's `restartRequirementText` (the web's
 * `restartNeeds` text, src/data/experiment-safety-actions.ts
 * RESTART_REQUIREMENT_TEXT). This copy is only the fallback for an older
 * server, held equal to the app's by tests/lib/experiments/rulings-1014-a.test.ts.
 * The CLI's own wording before 507 ("A restart needs a clinician ...", and no
 * "Until then it stays stopped") is retired.
 */
export const RESTART_REQUIREMENT_TEXT: Record<string, string> = {
  'clinician-advised':
    'To restart, a clinician must have reviewed this and advised that you can restart, with a plan you agreed. Having contacted them is not enough.',
  'documented-clearance':
    'This was a suspected serious reaction. It can only restart with a clinician’s documented clearance for this product. Until then it stays stopped. Do not take the product again to test it. A clearance alone is not enough: the clinician must also have explicitly ruled out a serious reaction to this product.',
  'pharmacist-schedule':
    'This was a timing pause. It can restart once your pharmacist or doctor has agreed a timing schedule with you.',
};

/** FNV-1a, 32 bit: the app's text-version hash (src/data/text-version.ts), held equal by test. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The version of a keyed text set, as the app computes it (`textSetVersion`). */
export function textSetVersion(prefix: string, texts: Readonly<Record<string, string>>): string {
  return `${prefix}-${fnv1a(
    JSON.stringify(
      Object.keys(texts)
        .sort()
        .map((k) => [k, texts[k]]),
    ),
  )}`;
}

/**
 * Pharmacist ruling 568 (19 October 2026, owner-approved "yes apply all
 * verbatim"): "Fallback text must have an identifiable version and tests for
 * equality." The version of the fallback copy above. It is the app's
 * RESTART_REQUIREMENT_TEXT_VERSION when the two copies are the same words:
 * tests/lib/experiments/rulings-1019-f-568.test.ts holds this literal equal to
 * the hash of the copy above and to the app's version, so neither can change
 * alone.
 */
export const RESTART_REQUIREMENT_TEXT_FALLBACK_VERSION = 'rrt1-25d8a03c';

/**
 * Pharmacist ruling 562 (19 October 2026), her W562, verbatim: printed for a
 * restart requirement this CLI does not know, in place of any raw code.
 * Ruling 568: "An unavailable server or unknown requirement cannot be
 * interpreted as release permission." The text is hers (group A's item 562 in
 * the app), held equal to her workbook by test.
 */
export const W562_UNMET_RESTART_REQUIREMENTS =
  'The experiment remains stopped because its restart requirements are incomplete. Follow the safety instructions and complete the review steps listed below. If a requirement is unclear, contact support for help with the record; contact your clinician for medical advice.';

/**
 * Ruling 507: the server's restart requirement text when it sends one, else the
 * fallback copy. Ruling 568: a requirement the fallback does not know (a newer
 * server's code, sent without its text) prints her W562, never an empty line
 * and never the bare code: it fails closed.
 */
export function restartRequirementLine(
  requires: string | null | undefined,
  serverText?: string | null,
): string {
  if (typeof serverText === 'string' && serverText) return serverText;
  if (!requires) return '';
  return RESTART_REQUIREMENT_TEXT[requires] ?? W562_UNMET_RESTART_REQUIREMENTS;
}

/**
 * Ruling 568: the version of the restart requirement text printed, kept with
 * it. The server's version when the server sent its text, else the fallback
 * copy's version, marked as the fallback. None when nothing was printed or W562
 * stood in for an unknown requirement (W562 is not a restart requirement text).
 */
export function restartRequirementVersionLine(
  requires: string | null | undefined,
  serverText?: string | null,
  serverVersion?: string | null,
): string {
  if (typeof serverText === 'string' && serverText) {
    return `(restart text version: ${typeof serverVersion === 'string' && serverVersion ? serverVersion : 'not sent by the server'})`;
  }
  if (requires && RESTART_REQUIREMENT_TEXT[requires])
    return `(restart text version: ${RESTART_REQUIREMENT_TEXT_FALLBACK_VERSION}, this CLI's copy)`;
  return '';
}

/** Ruling 507 and 568: the requirement line, then its version line, both dim. */
function outRestartRequirement(
  requires: string | null | undefined,
  serverText?: string | null,
  serverVersion?: string | null,
): void {
  const line = restartRequirementLine(requires, serverText);
  if (!line) return;
  out(dim(`  ${line}`));
  const v = restartRequirementVersionLine(requires, serverText, serverVersion);
  if (v) out(dim(`  ${v}`));
}

/**
 * Pharmacist ruling 444 (12 October 2026), her "Shared pause status note" and
 * "Short restart explanation", verbatim: printed when an older server sends
 * neither field. The app's PAUSE_STATUS_NOTE_444 and RESTART_PLAN_NOTE_444,
 * held equal by tests/lib/experiments/rulings-1012-a.test.ts.
 */
export const PAUSE_STATUS_NOTE_444 =
  'Your experiment is paused, so SupStack will not schedule its next check-in. Follow the product and treatment instructions above. This message is not medical clearance to start or restart.';
export const RESTART_PLAN_NOTE_444 =
  'Recording a clinician’s plan does not by itself allow this experiment to restart. All restrictions for this event and product must be resolved, and any applicable no-restart rule still applies.';

/**
 * Pharmacist ruling 502 (14 October 2026), her W502b, verbatim, in place of
 * ruling 239's "This is not a safety pause and needs no clinician record". The
 * app's STATUS_HOLD_NOTE_502, held equal by tests/lib/experiments/rulings-1014-a.test.ts.
 */
export const STATUS_HOLD_NOTE_502 =
  'This optional experiment is on hold while this information is clarified. Update your answer when it is clear. SupStack will check all applicable restrictions before allowing it to continue.';
/** Pharmacist ruling 239: how a status hold is updated (procedural), after her W502b. */
const STATUS_HOLD_TEXT = `  ${STATUS_HOLD_NOTE_502} To update it, run \`supstack experiments clarify-status <id> --screen <id>=<value> ...\` with every question the experiment lists, or finish the check-in if the answer was chosen in one that was not submitted.`;

/**
 * Finding R4-03 (22 October 2026): no competing monitoring advice under an
 * urgent top action. The app's `urgentTopHidesMonitoring` (safety-action.ts),
 * held equal by tests/lib/experiments/rulings-1022-a.test.ts.
 */
export function urgentTopHidesMonitoring(
  top: { category?: string; urgency?: string } | undefined,
  action: { category?: string; urgency?: string },
): boolean {
  if (!top || action.category !== 'monitor') return false;
  const urgent =
    top.category === 'emergency' ||
    top.category === 'pause-urgent' ||
    top.urgency === 'now' ||
    top.urgency === 'treat-now';
  return urgent && action.urgency !== 'now' && action.urgency !== 'treat-now';
}

/** Ruling 207: an instruction may carry bullet lines ("- "). Indented as they are. */
function outInstruction(text: string): void {
  for (const line of text.split('\n')) out(`  ${line}`);
}

/** Print a safety action, top instruction first, then any further distinct instruction. */
export function printSafetyAction(a: SafetyAction | null | undefined): void {
  if (!a) return;
  const heading = a.heading
    ? a.actions[0]?.notSure && a.category === 'monitor'
      ? 'Not sure: as a precaution (the experiment is not paused)'
      : a.heading
    : a.category === 'emergency'
      ? 'GET EMERGENCY HELP NOW'
      : a.blocksStart
        ? 'Do not start this experiment'
        : a.category === 'pause-urgent'
          ? 'Experiment paused: get assessed today'
          : a.category === 'pause-clinician'
            ? 'Experiment paused: contact your clinician'
            : a.category === 'hold'
              ? 'Hold your next dose until this is clear'
              : a.actions[0]?.notSure
                ? 'Not sure: as a precaution (the experiment is not paused)'
                : 'Keep an eye on this';
  const now = a.urgency === 'now' || a.urgency === 'treat-now';
  out(
    bold(a.category === 'emergency' || a.category === 'pause-urgent' || now ? red(heading) : yellow(heading)),
  );
  // Pharmacist rulings 628 and 653: her W653 lead under her heading, the event action, then her W653 tail, on an experiment that ended while paused.
  if (a.endedNote) out(a.endedNote);
  outInstruction(a.instruction);
  const seen = new Set([a.instruction]);
  for (const x of a.actions) {
    if (seen.has(x.instruction)) continue;
    seen.add(x.instruction);
    // Finding R4-03: no competing monitoring advice under an urgent top action.
    if (urgentTopHidesMonitoring(a.actions[0], x)) continue;
    outInstruction(x.instruction);
  }
  // Item 756 (R4-03): the escalation warnings of the hidden monitoring instruction, under her heading.
  if (a.otherWarnings) {
    out(bold(`  ${a.otherWarnings.heading}`));
    outInstruction(a.otherWarnings.text);
  }
  if (a.endedTail) out(`  ${a.endedTail}`);
  if (a.note) out(`  ${a.note}`);
  if (a.preStartRecordsNeeded?.length) {
    out(
      dim(
        `  Before the start, record the review for: ${a.preStartRecordsNeeded.join(', ')}. ` +
          'Resubmit with --prestart-review \'{"kind":"…","product":"…","dose":"…","history":"…","reviewerRole":"doctor","reviewedOn":"YYYY-MM-DD","advice":"…","patientReported":true}\'. ' +
          'It is your own account: SupStack does not check it with the clinician.',
      ),
    );
  }
  if (a.statusHold && !a.pauses) out(dim(STATUS_HOLD_TEXT));
  // Ruling 653 (R4-02): an experiment that ended has no pause note, restart requirement or restart explanation.
  if (a.pauses && !a.endedNote) {
    // Ruling 444: her shared pause status note replaces "no next check-in and no next dose".
    out(dim(`  ${a.pauseStatusNote ?? PAUSE_STATUS_NOTE_444}`));
    if (a.restartRequires)
      outRestartRequirement(a.restartRequires, a.restartRequirementText, a.restartRequirementTextVersion);
    // Ruling 444: her short restart explanation, beside the requirement, never instead of it.
    if (a.restartRequires) out(dim(`  ${a.restartPlanNote ?? RESTART_PLAN_NOTE_444}`));
    if (a.restartRequires === 'clinician-advised' && a.restartMustRecordExcluded?.length) {
      out(
        dim(
          `  The restart record must say the clinician considered and ruled out: ${a.restartMustRecordExcluded.join(', ')}. If not ruled out, it needs documented clearance.`,
        ),
      );
    }
  }
  out();
}

interface ExperimentResponse {
  type: string;
  checkInNumber: number | null;
  questionId: string;
  questionText: string;
  category: string;
  value: unknown;
  respondedAt: string;
  /** Owner call O-4 (14 October 2026): the safety display version the answer was given under, or "version not recorded". */
  safetyDisplayVersion?: string;
}

export interface ExperimentDetail extends ExperimentListItem {
  /** The most recent check-in's safety action, or null. */
  safetyAction: SafetyAction | null;
  /**
   * Pharmacist ruling 207: the action comes from an answer chosen on the web
   * and never submitted, which paused the experiment the moment it was chosen.
   */
  pendingSafetyEvent?: boolean;
  /** Paused for safety: a restart needs the record named in `restartRequires`. */
  pausedForSafety?: boolean;
  /**
   * Owner call O-6 (14 October 2026): the refusal `experiments restart` would
   * get whatever record is sent (`permanently_excluded` or
   * `app_restart_unavailable`), present when `held` is true. Its text is the
   * server's reviewed text: printed as sent, never composed here.
   */
  heldRefusal?: HeldRefusal;
  /** Pharmacist ruling 239: on a status hold, released by a definite answer (`clarify-status`). */
  statusHold?: boolean;
  /** Ruling 256 (W1), 258, 259: how to update the answer that holds the next dose. */
  updateAnswer?: {
    source?: string;
    how?: string;
    questions?: string[];
    web?: string;
    /** Ruling 259: the answer chosen in the unfinished check-in, on any device. */
    chosenAnswers?: { questionId: string; question?: string; value: unknown }[];
    chosenAt?: string | null;
    confirmNow?: string;
    notStopPrescribed?: string;
  };
  /** Ruling 281 call 5: the web and Telegram profiles disagree about a medicine. */
  medicineConflict?: string;
  restartRequires?: 'pharmacist-schedule' | 'clinician-advised' | 'documented-clearance';
  /** Ruling 507: the server's restart requirement text. */
  restartRequirementText?: string;
  /** Ruling 568: the version of that text. */
  restartRequirementTextVersion?: string;
  /** Ruling 261: where the safety pause restarts, with the restart record, on every channel. */
  restartRoute?: {
    api?: string;
    cli?: string;
    mcp?: string;
    web?: string;
    assistant?: string;
    note?: string;
  };
  /** The check-in questions to ask now: the frozen protocol plus the current safety screen. */
  checkInQuestions?: QuestionDoc[];
  verdictDetails: unknown;
  protocol: unknown;
  baselineCompletedAt: string | null;
  responses: ExperimentResponse[];
  /**
   * Finding F16 (pharmacist, 12 October 2026): the server shows a frozen
   * protocol, its questions and the stored answers' question text with the
   * CURRENT safety text for the same stable key. `version` names the text shown.
   */
  safetyDisplay?: { version: string; source: 'live' | 'frozen' };
}

/** The restart refusal a held experiment carries (owner call O-6), the restart's own 409 body. */
export interface HeldRefusal {
  error: string;
  holdState?: string;
  message?: string;
  refusal?: { urgentLead?: string; actions?: string[]; hold?: string[] } | null;
  heldRows?: { row: string; reason: string; state: string; value?: string }[];
  productWide?: true;
  priorExperiments?: unknown[];
  footer?: string;
}

/**
 * Owner call O-6: print a held experiment's refusal the way a refused restart
 * prints (ruling 505: her urgent lead as a heading, each action and each hold
 * paragraph apart, then the footer), or its message when it has no structured
 * refusal. Only the server's text. Returns whether anything was printed.
 */
export function printHeldRefusal(h: HeldRefusal | undefined): boolean {
  if (!h) return false;
  const r = h.refusal;
  if (r && typeof r.urgentLead === 'string' && r.urgentLead) {
    out(red(bold(r.urgentLead)));
    for (const a of r.actions ?? []) out(`\n${a}`);
    for (const x of r.hold ?? []) out(`\n${x}`);
  } else if (h.message) {
    out(red(bold(h.message)));
  } else {
    return false;
  }
  if (h.footer) out(`\n${h.footer}`);
  // Owner call O-6 (kept deliberately, pinned by owner-calls-1014.test.ts): the code follows the reviewed text, as a reference.
  out(dim(`  (${h.error})`));
  out();
  return true;
}

function requireToken(): string {
  const token = getToken();
  if (!token) throw new NotLoggedInError();
  return token;
}

export async function getExperiments(
  status?: string,
  fetchImpl?: typeof fetch,
): Promise<ExperimentListItem[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiGetAuthed<{ data: ExperimentListItem[] }>(`/me/experiments${q}`, requireToken(), {
    fetchImpl,
  });
  return res.data;
}

export async function getExperiment(id: string, fetchImpl?: typeof fetch): Promise<ExperimentDetail> {
  const res = await apiGetAuthed<{ data: ExperimentDetail }>(
    `/me/experiments/${encodeURIComponent(id)}`,
    requireToken(),
    { fetchImpl },
  );
  return res.data;
}

// ─── Formatting ──────────────────────────────────────────────────────────

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function statusBadge(status: string): string {
  if (status === 'completed') return cyan(status);
  if (status === 'active') return bold(status);
  return dim(status);
}

function verdictBadge(verdict: string | null): string {
  if (!verdict) return '';
  if (verdict === 'clear-win' || verdict === 'probable-win') return cyan(verdict);
  if (verdict === 'not-effective' || verdict === 'stop') return yellow(verdict);
  return dim(verdict);
}

const shortId = (id: string): string => id.slice(0, 8);
const date = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an id or short prefix (as shown by `experiments list`) to a full uuid,
 * git-style. Full uuids pass through; a prefix is matched against the list.
 */
export async function resolveExperimentId(idOrPrefix: string): Promise<string> {
  if (UUID_RE.test(idOrPrefix)) return idOrPrefix;
  const matches = (await getExperiments()).filter((e) =>
    e.id.toLowerCase().startsWith(idOrPrefix.toLowerCase()),
  );
  if (matches.length === 0)
    throw new Error(`No experiment matching "${idOrPrefix}". Run \`supstack experiments list\`.`);
  if (matches.length > 1)
    throw new Error(`"${idOrPrefix}" is ambiguous (${matches.length} matches). Use more characters.`);
  return matches[0]!.id;
}

/** `supstack experiments list` */
export async function runExperimentsList(status: string | undefined, asJson: boolean): Promise<void> {
  const experiments = await getExperiments(status);
  if (asJson) {
    out(JSON.stringify({ experiments }, null, 2));
    return;
  }
  if (experiments.length === 0) {
    out(dim(status ? `No ${status} experiments.` : 'No experiments yet.'));
    return;
  }
  for (const e of experiments) {
    const verdict = verdictBadge(e.verdict);
    out(
      `${dim(shortId(e.id))}  ${bold(e.supplement.name)} ${dim('×')} ${e.goal.name}  ${statusBadge(e.status)}` +
        `  ${dim(`${e.progress.completed}/${e.progress.expected}`)}${verdict ? `  ${verdict}` : ''}` +
        // Owner call O-6: the raw code stays (scripts, support). Item 1110 row 4: her 748 text for the code goes under the row.
        (e.held && e.heldReason ? `  ${red(e.heldReason.error)}` : ''),
    );
    // A held row with no readable code gets her "could not be interpreted" line and no code, never a clear or eligible reading.
    if (e.held) out(`    ${heldCodeListText(e.heldReason?.error)}`);
    printSafetyScreen(e.safety, '    ');
  }
  out();
  // Ruling 601: her W601 under the list whenever an experiment runs or is paused.
  if (experiments.some((e) => e.status === 'active' || e.status === 'paused')) {
    printReportLead();
    out(dim('  Report it with `supstack experiments report <id>`.'));
    out();
  }
  out(dim('Show one with `supstack experiments show <id>`.'));
}

/** `supstack experiments show <id>` (accepts the short id from `list`) */
export async function runExperimentShow(idOrPrefix: string, asJson: boolean): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  const e = await getExperiment(id);
  if (asJson) {
    out(JSON.stringify({ experiment: e }, null, 2));
    return;
  }
  if (e.pendingSafetyEvent) {
    out(
      yellow(
        'From an answer chosen at a check-in that was not submitted. The experiment was paused the moment it was chosen.',
      ),
    );
  }
  printSafetyAction(e.safetyAction);
  // Owner call O-6 (14 October 2026): a held experiment shows the refusal its
  // restart would get, before any restart is attempted, and no restart hint.
  const held = e.held === true && printHeldRefusal(e.heldRefusal);
  if (held && e.pausedForSafety && !e.safetyAction?.pauses) {
    out(red(bold('Paused for safety')));
    out(
      dim(
        `  If the answer that paused it was chosen by mistake (nothing happened), correct it with \`supstack experiments correct ${shortId(id)} --check-in ${e.progress.completed} ...\`.`,
      ),
    );
    out();
  } else if (e.pausedForSafety && !e.safetyAction?.pauses) {
    out(red(bold('Paused for safety')));
    out(
      `  This experiment was paused for safety. Do not take the next dose. It restarts only with the restart record: \`supstack experiments restart ${shortId(id)}\` shows what it needs.`,
    );
    if (e.restartRequires)
      outRestartRequirement(e.restartRequires, e.restartRequirementText, e.restartRequirementTextVersion);
    out(
      dim(
        `  If the answer that paused it was chosen by mistake (nothing happened), correct it with \`supstack experiments correct ${shortId(id)} --check-in ${e.progress.completed} ...\`.`,
      ),
    );
    out();
  }
  if (e.statusHold) {
    if (!e.safetyAction?.statusHold) {
      out(yellow(bold('On hold')));
      out(STATUS_HOLD_TEXT);
    }
    if (e.updateAnswer?.chosenAnswers?.length) {
      // Ruling 279 F row 17: the saved answer with its date, or "date unknown",
      // and a request to confirm what is happening now.
      out(
        `  Your earlier answer, saved on ${e.updateAnswer.chosenAt ? date(e.updateAnswer.chosenAt) : 'date unknown'}:`,
      );
      for (const a of e.updateAnswer.chosenAnswers) {
        out(
          `    ${a.question ?? a.questionId}: ${Array.isArray(a.value) ? a.value.join(', ') : String(a.value)}`,
        );
      }
      out(
        `  ${(e.updateAnswer.confirmNow ?? 'Your earlier answer was saved on {date}. Confirm what is happening now, then complete the follow-up. Until it is clear, hold the next dose of this optional product.').replace(/^Your earlier answer was saved on [^.]*\. /, '')}`,
      );
    }
    if (e.updateAnswer?.how) out(dim(`  ${e.updateAnswer.how}`));
    if (e.updateAnswer?.questions?.length) out(dim(`  Questions: ${e.updateAnswer.questions.join(', ')}`));
    if (e.updateAnswer?.notStopPrescribed) out(dim(`  ${e.updateAnswer.notStopPrescribed}`));
    out();
  }
  if (e.medicineConflict) out(yellow(`  ${e.medicineConflict}`));
  if (e.safetyAction?.populationPlansRequired?.length) {
    out(
      dim(
        `  A restart needs a ${e.safetyAction.populationPlansRequired.join(' and ')} plan for this product${e.safetyAction.planOnly ? ' (no event questions: this pause is for the plan)' : ''}.`,
      ),
    );
  }
  out(`${bold(e.supplement.name)} ${dim('×')} ${e.goal.name}`);
  out(
    `  ${statusBadge(e.status)} · ${e.progress.completed}/${e.progress.expected} check-ins` +
      (e.startedAt ? dim(` · started ${date(e.startedAt)}`) : ''),
  );
  if (e.verdict) {
    out(`  ${bold('Verdict')} ${verdictBadge(e.verdict)}${e.verdictSummary ? ` — ${e.verdictSummary}` : ''}`);
  } else if (e.nextCheckInDate) {
    out(dim(`  Next check-in: ${date(e.nextCheckInDate)}`));
  }
  if (e.safetyDisplay?.version) out(dim(`  Safety text version: ${e.safetyDisplay.version}`));
  // Ruling 601 (19 October 2026): her W601 on every running or paused experiment, at any time.
  const report = (e as { safetyReport?: { action?: string; emergencyLine?: string } }).safetyReport;
  if (report) {
    printReportLead(report.action, report.emergencyLine);
    out(dim(`  Report it with \`supstack experiments report ${shortId(id)}\`.`));
  }
  const latestReport = (e as { latestSafetyReport?: { reportNumber: number; reportedAt: string | null } })
    .latestSafetyReport;
  if (latestReport)
    out(
      dim(
        `  Latest safety report: ${latestReport.reportNumber} (${latestReport.reportedAt ? date(latestReport.reportedAt) : 'date unknown'})`,
      ),
    );
  // Ruling 548 (14 October 2026): her W548, which the server sets beside a frozen schedule that is no longer the current one.
  const scheduleNote = (e.protocol as { protocol?: { historicalScheduleNote?: string } } | null)?.protocol
    ?.historicalScheduleNote;
  if (scheduleNote) out(dim(`  ${scheduleNote}`));
  const checkIns = e.responses.filter((r) => r.type === 'check-in');
  if (checkIns.length) {
    out();
    out(bold('Check-ins'));
    for (const r of checkIns.slice(-12)) {
      const n = r.checkInNumber !== null ? `#${r.checkInNumber} ` : '';
      out(
        dim(`  ${n}${r.questionText}: `) +
          String(r.value) +
          dim(` (safety text version: ${r.safetyDisplayVersion ?? 'version not recorded'})`),
      );
    }
  }
}

// ─── Write: protocol preview, start, check-in ────────────────────────────

export interface QuestionDoc {
  id: string;
  text: string;
  type: string;
  category: string;
  required: boolean;
  /**
   * The question may be left blank even though its category would otherwise
   * make it required — a lab value the user cannot produce on demand, e.g.
   * "Sperm concentration on the repeat analysis. (leave blank if not retested)".
   * Set on the server; this client must not ignore it.
   */
  optional?: boolean;
  unit?: string;
  scale?: { min: number; max: number; lowLabel?: string; highLabel?: string };
  range?: { min: number; max: number };
  options?: { value: string; label: string }[];
  /** A safety question accepts "not-sure" as an answer (owner decision 2026-10-05). Set by the server. */
  notSureAllowed?: boolean;
  /**
   * Pharmacist ruling 208: a conditional follow-up, asked (and required) only
   * when `questionId` was answered with one of `values`, or, with `anyExcept`
   * (ruling 220 Q50), with any answer outside that list.
   */
  askIf?: { questionId: string; values: string[]; anyExcept?: string[] };
}

/** The stored value of a "not sure" answer. Mirrors `NOT_SURE` in the app. */
export const NOT_SURE = 'not-sure';

/**
 * Pharmacist ruling 282 call 1 (approved 7 October 2026): questions that do
 * not offer the generic "not-sure" to a new answer, because each lists its own
 * explicit current and past uncertainty. Still required. Mirrors
 * `NO_GENERIC_NOT_SURE` in src/lib/experiments/safety-answers.ts, which this
 * package cannot import; tests/lib/safety-required-parity.test.ts holds the two
 * to the same set.
 */
// Rulings 575 and 577 (19 October 2026): her W575 and W577 each list their own
// uncertainty answer ("I cannot tell what happened", "Not sure"), so no generic one.
export const NO_GENERIC_NOT_SURE: ReadonlySet<string> = new Set([
  'hypo-symptoms',
  'side-effects-hypo',
  'allergic-reaction-bp-clarify',
  'allergic-reaction-rj-clarify',
  'side-effects-allergy-clarify',
  'side-effects-allergy-status',
  // Ruling 669 (22 October 2026): her W669 first question lists its own "not sure".
  'allergic-reaction-bp-symptoms-now',
  'allergic-reaction-rj-symptoms-now',
  'side-effects-allergy-symptoms-now',
]);

/**
 * Owner decision 2026-10-05: every safety question with a fixed answer set is
 * required at a check-in and offers "not-sure". Mirrors `isRequiredSafetyQuestion`
 * in src/lib/experiments/safety-answers.ts, which this package cannot import.
 * Recomputed here because the check-in questions come from the FROZEN protocol,
 * which carries no `required` flag.
 */
export function isRequiredSafetyQuestion(q: { category: string; type: string }): boolean {
  // Ruling 220 Q8: a free-text safety question is required too (an empty field is not "none").
  return (
    q.category === 'safety' &&
    (q.type === 'yesno' || q.type === 'choice' || q.type === 'multi' || q.type === 'text')
  );
}

/**
 * Pharmacist ruling 208: whether a conditional follow-up is asked, given the
 * answers so far. Mirrors `isQuestionAsked` in src/lib/experiments/safety-answers.ts.
 */
export function isQuestionAsked(
  q: { askIf?: { questionId: string; values: string[]; anyExcept?: string[] } },
  answers: Record<string, unknown>,
): boolean {
  if (!q.askIf) return true;
  const askIf = q.askIf;
  const raw = answers[askIf.questionId];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.some((v) => {
    if (v === undefined || v === null) return false;
    let s = String(v).trim().toLowerCase();
    if (s === '') return false;
    if (['not sure', 'unsure', 'notsure'].includes(s)) s = NOT_SURE;
    if (s === 'true') s = 'yes';
    if (s === 'false') s = 'no';
    if (askIf.values.includes(s)) return true;
    return Boolean(askIf.anyExcept && !askIf.anyExcept.includes(s));
  });
}

interface ProtocolPreview {
  supplement: { id: string; name: string; slug: string };
  goal: { id: string; name: string };
  /** `dose` is null for a withdrawn dose (F13), her W541 for no endorsed dose (ruling 541). */
  dosing: { dose: string | null; timing: string | null; warnings?: string[] };
  schedule: { totalCheckIns: number };
  baselineQuestions: QuestionDoc[];
  checkInQuestions: QuestionDoc[];
}

interface CreatedExperiment {
  /**
   * ⚠️ Round 95. The caller's verdict for this supplement at the moment of
   * COMMITMENT. Declared in the same round the API started sending it — round
   * 94 is what happens when the type lags the payload.
   */
  safety?: {
    level: 'block' | 'warn' | 'unavailable' | 'unrecognised' | 'unchecked';
    risks: string[];
    uncheckedAxes?: string[];
  } | null;
  id: string;
  supplement: { slug: string; name: string };
  goal: { id: string; name: string };
  status: string;
  progress: { completed: number; expected: number };
  startedAt: string;
  nextCheckInDate: string | null;
}

interface CheckInResult {
  /** Owner ruling 192.1: shown first. Null when no answer triggered an action. */
  safetyAction: SafetyAction | null;
  id: string;
  status: string;
  /** Pharmacist ruling 239: the check-in put the experiment on a status hold. */
  statusHold?: boolean;
  checkInNumber: number;
  progress: { completed: number; expected: number };
  nextCheckInDate?: string | null;
  verdict?: string;
  verdictSummary?: string;
  /**
   * ⚠️ Round 94. The check-in response carries the caller's verdict for this
   * supplement as of NOW, and `'unavailable'` when the profile could not be read
   * at all — round 81's distinction between "checked, fine" and "not checked".
   * Undeclared here, so the one level that means *nobody screened this* was the
   * one a client could not see.
   */
  safety?: {
    level: 'block' | 'warn' | 'unavailable' | 'unrecognised' | 'unchecked';
    risks: string[];
    uncheckedAxes?: string[];
  } | null;
}

export async function getExperimentProtocol(
  supplement: string,
  goal: string,
  fetchImpl?: typeof fetch,
): Promise<ProtocolPreview> {
  const q = `?supplement=${encodeURIComponent(supplement)}&goal=${encodeURIComponent(goal)}`;
  const res = await apiGetAuthed<{ data: ProtocolPreview }>(`/me/experiments/protocol${q}`, requireToken(), {
    fetchImpl,
  });
  return res.data;
}

export async function startExperiment(
  supplement: string,
  goal: string,
  answers: Record<string, unknown>,
  fetchImpl?: typeof fetch,
  preStartReviews: unknown[] = [],
  restartRecord?: unknown,
): Promise<CreatedExperiment> {
  const res = await apiPost<{ data: CreatedExperiment }>(
    '/me/experiments',
    {
      supplement,
      goal,
      answers,
      ...(preStartReviews.length > 0 ? { preStartReviews } : {}),
      // Owner decision 3 (6 October 2026): the restart record of an earlier
      // experiment that ended while paused for safety, stored against it.
      ...(restartRecord !== undefined ? { restartRecord } : {}),
    },
    { bearer: requireToken(), fetchImpl },
  );
  return res.data;
}

export async function checkInExperiment(
  id: string,
  answers: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<CheckInResult> {
  const res = await withUnknownOutcome('check-in', id, () =>
    apiPost<{ data: CheckInResult }>(
      `/me/experiments/${encodeURIComponent(id)}/check-in`,
      { answers },
      { bearer: requireToken(), fetchImpl },
    ),
  );
  return res.data;
}

/** Parse repeated `--answer id=value` into an answers object. */
export function parseAnswers(kvs: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const kv of kvs) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new Error(`Bad --answer "${kv}". Use id=value, e.g. --answer sleep-onset=25.`);
    answers[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return answers;
}

export function questionHint(q: QuestionDoc): string {
  const notSure =
    q.notSureAllowed ?? (isRequiredSafetyQuestion(q) && q.type !== 'text' && !NO_GENERIC_NOT_SURE.has(q.id));
  if (q.type === 'scale' && q.scale) return dim(` [${q.scale.min}–${q.scale.max}]`);
  if (q.type === 'number' && q.range)
    return dim(` [${q.range.min}–${q.range.max}${q.unit ? ` ${q.unit}` : ''}]`);
  if (q.type === 'yesno') return dim(notSure ? ` [yes | no | ${NOT_SURE}]` : ' [yes | no]');
  if (q.options?.length) {
    const values = q.options.map((o) => o.value);
    if (notSure && !values.includes(NOT_SURE)) values.push(NOT_SURE);
    return dim(` [${values.join(' | ')}]`);
  }
  return q.unit ? dim(` [${q.unit}]`) : '';
}

/** The stomach or bowel follow-up (her W617/W728), which names the selected symptom beside its stem. */
const GI_FOLLOW_UP_ID = 'side-effects-gi-now';

function renderQuestions(title: string, questions: QuestionDoc[]): void {
  out(bold(title));
  for (const q of questions) {
    const tag = q.required ? yellow(q.askIf ? ' (required if asked)' : ' (required)') : dim(' (optional)');
    out(`  ${cyan(q.id)}${tag}${questionHint(q)}`);
    if (q.askIf) out(dim(`    Only if ${q.askIf.questionId} is ${q.askIf.values.join(' or ')}.`));
    // Item 850 (9 November 2026): the selected symptom stays visible on this channel too, by the labels the parent question shows.
    if (q.askIf && q.id === GI_FOLLOW_UP_ID) {
      const parent = questions.find((x) => x.id === q.askIf!.questionId);
      const labels = q.askIf.values.flatMap(
        (v) => parent?.options?.find((o) => String(o.value) === v)?.label ?? [],
      );
      if (labels.length > 0) out(dim(`    Symptom: ${labels.join(', ')}`));
    }
    for (const line of q.text.split('\n')) out(dim(`    ${line}`));
  }
}

/** If a 400 carried a `missing` question list, print it; always rethrow. */
function reportMissing(err: unknown): never {
  // Owner decision 3 (6 October 2026): an earlier experiment with this
  // supplement ended while paused for safety. Say how to give its record.
  if (
    err instanceof ApiError &&
    err.body &&
    typeof err.body === 'object' &&
    (err.body as { error?: string }).error === 'prior_safety_pause'
  ) {
    const b = err.body as {
      restartRequires?: string;
      restartRequirementText?: string;
      restartRequirementTextVersion?: string;
      restartRecordProblems?: string[];
      eligibility?: string;
    };
    out(bold(yellow('An earlier experiment with this supplement ended while paused for safety')));
    // Ruling 568: the server's text and version, else the fallback copy and its version (W562 for an unknown code).
    if (b.restartRequires) {
      out(`  ${restartRequirementLine(b.restartRequires, b.restartRequirementText)}`);
      const v = restartRequirementVersionLine(
        b.restartRequires,
        b.restartRequirementText,
        b.restartRequirementTextVersion,
      );
      if (v) out(dim(`  ${v}`));
    }
    // Pharmacist ruling 381: the complete restart rule, as the API states it.
    if (b.eligibility) out(`  ${b.eligibility}`);
    // Ruling 562: never the raw problem code as an explanation. `--json` keeps `restartRecordProblems` for scripts.
    out(
      dim(
        '  Resubmit with --restart-record \'{"reviewerRole":"doctor","reviewedOn":"YYYY-MM-DD","dose":"…","productForm":"…","restartPlan":"…","clinicianAdvisedRestart":true,"seriousIllness":"excluded","seriousInjury":"excluded","eventResolution":"resolved","otherExposures":"…"' +
          (b.restartRequires === 'documented-clearance' ? ',"clearanceReference":"…"' : '') +
          "}'. It is stored against the earlier experiment, as your own account: SupStack does not check it with the clinician.",
      ),
    );
  }
  // Pharmacist ruling 198: a baseline safety answer stopped the start. Show the
  // instruction first, exactly as a check-in would.
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'safetyAction' in err.body) {
    printSafetyAction((err.body as { safetyAction?: SafetyAction }).safetyAction);
  }
  // Pharmacist ruling 412 (10 October 2026): every refusal that carries the
  // eligibility rule prints it (her pre-start rule on a start), not only the
  // prior-pause one above.
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const b = err.body as { error?: string; eligibility?: string };
    if (b.eligibility && b.error !== 'prior_safety_pause') out(`  ${b.eligibility}`);
  }
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'missing' in err.body) {
    const missing = (err.body as { missing?: QuestionDoc[] }).missing ?? [];
    if (missing.length) {
      process.stderr.write(yellow('Still need answers for:') + '\n');
      for (const q of missing) process.stderr.write(`  ${cyan(q.id)}${questionHint(q)} — ${q.text}\n`);
    }
  }
  throw err;
}

/** `supstack experiments protocol <supplement> <goal>` */
export async function runExperimentProtocol(
  supplement: string,
  goal: string,
  asJson: boolean,
): Promise<void> {
  const p = await getExperimentProtocol(supplement, goal);
  if (asJson) {
    out(JSON.stringify({ protocol: p }, null, 2));
    return;
  }
  out(`${bold(p.supplement.name)} ${dim('×')} ${p.goal.name}`);
  // Finding F13 (14 October 2026): a withdrawn dose or timing is null and must
  // not print as "null". The web export's own neutral string, never a number.
  out(
    dim(
      `  ${p.dosing.dose ?? 'Not established'} · ${p.dosing.timing ?? 'Not established'} · ${p.schedule.totalCheckIns} check-ins`,
    ),
  );
  // Item 742 (22 October 2026): the product's own warnings, verbatim, beside the dose.
  for (const w of p.dosing.warnings ?? []) out(`  Warning: ${w}`);
  out();
  renderQuestions('Baseline questions', p.baselineQuestions);
  out();
  out(
    dim(
      `Start with: supstack experiments start ${p.supplement.slug} ${p.goal.id} ` +
        p.baselineQuestions
          .filter((q) => q.required)
          .map((q) => `--answer ${q.id}=…`)
          .join(' '),
    ),
  );
}

type SafetyScreen =
  | {
      level: 'block' | 'warn' | 'unavailable' | 'unrecognised' | 'unchecked';
      risks: string[];
      uncheckedAxes?: string[];
    }
  | null
  | undefined;

/**
 * The caller's population screen for this supplement, as the server sent it
 * (start, check-in and list all carry it). Until 14 October 2026 only `--json`
 * showed it: the human output of `start` said "Started" and nothing else, so a
 * warn (or `unavailable`, nobody screened this) never reached the terminal.
 * Every line printed is the server's own text. The markers follow
 * recommend.ts: a finding is ⚠ (✕ for a block), "not checked" is ○.
 */
export function printSafetyScreen(safety: SafetyScreen, indent = '  '): void {
  if (!safety) return;
  const marker = safety.level === 'block' ? red('✕') : safety.level === 'warn' ? yellow('⚠') : dim('○');
  for (const risk of safety.risks)
    out(`${indent}${marker} ${safety.level === 'block' || safety.level === 'warn' ? risk : dim(risk)}`);
  if (safety.uncheckedAxes?.length)
    out(`${indent}${dim('○')} ${dim(`Not checked: ${safety.uncheckedAxes.join(', ')}`)}`);
}

/** `supstack experiments start <supplement> <goal> [--answer id=value ...]` */
export async function runExperimentStart(
  supplement: string,
  goal: string,
  answerKvs: string[],
  asJson: boolean,
  reviewJson: string[] = [],
  restartRecordJson?: string,
): Promise<void> {
  // No answers → show the baseline questions to answer (don't create anything).
  if (answerKvs.length === 0) {
    await runExperimentProtocol(supplement, goal, asJson);
    return;
  }
  const answers = parseAnswers(answerKvs);
  const reviews = reviewJson.map((j) => {
    try {
      return JSON.parse(j) as unknown;
    } catch {
      throw new Error(`Bad --prestart-review: not JSON: ${j}`);
    }
  });
  let restartRecord: unknown;
  if (restartRecordJson !== undefined) {
    try {
      restartRecord = JSON.parse(restartRecordJson) as unknown;
    } catch {
      throw new Error(`Bad --restart-record: not JSON: ${restartRecordJson}`);
    }
  }
  let e: CreatedExperiment;
  try {
    e = await startExperiment(supplement, goal, answers, undefined, reviews, restartRecord);
  } catch (err) {
    reportMissing(err);
  }
  if (asJson) {
    out(JSON.stringify({ experiment: e }, null, 2));
    return;
  }
  out(green('Started') + dim(` — ${e.supplement.name} × ${e.goal.name}`));
  out(`  ${dim(shortId(e.id))} · ${statusBadge(e.status)} · 0/${e.progress.expected} check-ins`);
  if (e.nextCheckInDate) out(dim(`  First check-in: ${date(e.nextCheckInDate)}`));
  printSafetyScreen(e.safety);
}

// ─── Report a symptom or safety concern (pharmacist ruling 601) ─────────

/**
 * Pharmacist ruling 601 (19 October 2026, owner-approved "yes apply all
 * verbatim"), her W601: "Report a symptom or safety concern", at any time.
 * The fallback for an older server that sends no `safetyReport`: her label and
 * display line, held equal to the app's by tests/lib/experiments/rulings-1019-f-601.test.ts.
 */
export const W601_REPORT_ACTION = 'Report a symptom or safety concern';
export const W601_REPORT_EMERGENCY_LINE =
  'If you have an emergency warning sign, get help now; do not wait to complete this report.';

export interface SafetyReportResult {
  reportNumber: number;
  safetyAction: SafetyAction | null;
  paused: boolean;
  statusHold: boolean;
  checkInsCompleted: number;
  action?: string;
  emergencyLine?: string;
  /** Ruling 704: the experiment's status after the report. An ended experiment stays ended. */
  experimentStatus?: string;
  /** Ruling 709: the server's saved text (her W709 with the real state), printed as sent. */
  saved?: string;
  /** Ruling 705: what a clarification did. */
  clarification?: {
    reportNumber: number;
    clarifies: { reportNumber: number; questionId: string; kind: string };
    originalActs: string;
    statusHoldResolved: boolean;
    restrictionKept: boolean;
    remainingHolds?: number;
  };
  safetyDisplay?: { version: string; source: string };
  /** The population re-screen, inside data as on a check-in. */
  safety?: SafetyScreen;
}

/** Ruling 705: the earlier answer a report clarifies. */
export interface ReportClarifies {
  reportNumber: number;
  questionId: string;
  kind?: 'situation-changed' | 'entered-by-mistake';
}

/** `POST /me/experiments/:id/safety-report` with `{ answers }`, and `clarifies` for a clarification (ruling 705). */
export async function postSafetyReport(
  id: string,
  answers: Record<string, unknown>,
  clarifies?: ReportClarifies,
  fetchImpl?: typeof fetch,
): Promise<SafetyReportResult> {
  const res = await apiPost<{ data: SafetyReportResult }>(
    `/me/experiments/${encodeURIComponent(id)}/safety-report`,
    { answers, ...(clarifies ? { clarifies } : {}) },
    { bearer: requireToken(), fetchImpl },
  );
  return res.data;
}

/** `--clarify <reportNumber>:<questionId>` of `supstack experiments report`. */
export function parseClarify(raw: string, kind?: string): ReportClarifies {
  const m = /^(\d+):(.+)$/.exec(raw.trim());
  if (!m)
    throw new Error(
      '--clarify takes <reportNumber>:<questionId>, for example 1:pregnancy-status (see the saved answers of `supstack experiments report <id>`).',
    );
  if (kind !== undefined && kind !== 'situation-changed' && kind !== 'entered-by-mistake') {
    throw new Error('--kind is situation-changed or entered-by-mistake.');
  }
  return { reportNumber: Number(m[1]), questionId: m[2]!, ...(kind ? { kind } : {}) };
}

/** Ruling 601: the action and her display line, as the server sends them (or the fallback). */
function printReportLead(action?: string, emergencyLine?: string): void {
  out(bold(red(action ?? W601_REPORT_ACTION)));
  out(red(`  ${emergencyLine ?? W601_REPORT_EMERGENCY_LINE}`));
}

/**
 * `supstack experiments report <id> [--answer id=value ...]`. Ruling 601: a
 * report of a symptom or safety concern at any time while the experiment runs
 * or is paused, the safety questions only. No answers shows them, her W601
 * display line first. Answers are assessed exactly as a check-in's: the action
 * prints first, and a pausing answer pauses the experiment. A report never
 * takes a check-in's place or moves the schedule.
 */
export async function runExperimentReport(
  idOrPrefix: string,
  answerKvs: string[],
  asJson: boolean,
  clarify?: { raw: string; kind?: string },
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  const clarifies = clarify ? parseClarify(clarify.raw, clarify.kind) : undefined;
  if (answerKvs.length === 0) {
    const e = await getExperiment(id);
    const report = (
      e as {
        safetyReport?: {
          action?: string;
          emergencyLine?: string;
          questions?: QuestionDoc[];
          clarify?: { heading?: string; body?: string };
          correct?: { heading?: string; body?: string };
          savedAnswers?: {
            reportNumber: number;
            questionId: string;
            question: string;
            value: unknown;
            acts: string;
          }[];
        };
      }
    ).safetyReport;
    if (asJson) {
      out(JSON.stringify({ safetyReport: report ?? null }, null, 2));
      return;
    }
    printReportLead(report?.action, report?.emergencyLine);
    if (!report) {
      out(dim('  This experiment takes a report while it is running, paused or ended.'));
      return;
    }
    out();
    if (clarifies) {
      // Ruling 705: her entry text as the server sends it, then the saved answers.
      if (report.clarify?.heading) out(bold(report.clarify.heading));
      if (report.clarify?.body) out(`  ${report.clarify.body}`);
      const q = (report.questions ?? []).find((x) => x.id === clarifies.questionId);
      renderQuestions('Answer again', q ? [{ ...q, required: true }] : []);
      out();
      out(
        dim(
          `Submit with: supstack experiments report ${shortId(id)} --clarify ${clarifies.reportNumber}:${clarifies.questionId} --answer <id>=<value> ...`,
        ),
      );
      return;
    }
    renderQuestions(
      'Safety questions',
      (report.questions ?? []).map((q) => ({ ...q, required: true })),
    );
    if ((report.savedAnswers ?? []).length > 0) {
      out();
      if (report.clarify?.heading) out(bold(report.clarify.heading));
      if (report.clarify?.body) out(`  ${report.clarify.body}`);
      for (const a of report.savedAnswers ?? []) {
        out(
          `  report ${a.reportNumber}  ${a.questionId}: ${Array.isArray(a.value) ? a.value.join(', ') : String(a.value)}${a.acts !== 'none' ? dim(` (${a.acts})`) : ''}`,
        );
      }
      out(
        dim(
          `  Clarify one with: supstack experiments report ${shortId(id)} --clarify <reportNumber>:<questionId> --answer <id>=<value>`,
        ),
      );
      if (report.correct?.heading) out(bold(report.correct.heading));
      if (report.correct?.body) out(`  ${report.correct.body}`);
    }
    out();
    out(dim(`Submit with: supstack experiments report ${shortId(id)} --answer <id>=<value> ...`));
    return;
  }
  let r: SafetyReportResult;
  try {
    r = await postSafetyReport(id, parseAnswers(answerKvs), clarifies);
  } catch (err) {
    // The action first, from a refused or failed report too.
    if (err instanceof ApiError && err.body && typeof err.body === 'object') {
      // reportMissing prints a refusal's safetyAction; her display line leads when there is none.
      const b = err.body as { safetyAction?: SafetyAction; emergencyLine?: string; saveFailed?: string };
      if (!b.safetyAction && b.emergencyLine) printReportLead(undefined, b.emergencyLine);
      // Ruling 709: the save failed, and the urgent advice above stays.
      if (b.saveFailed) process.stderr.write(red(b.saveFailed) + '\n');
    }
    reportMissing(err);
  }
  if (asJson) {
    out(JSON.stringify({ safetyReport: r }, null, 2));
    return;
  }
  printSafetyAction(r.safetyAction);
  // Ruling 709: the server's saved text, with the real state; never "saved" before the write.
  out(
    green(r.saved ?? `Safety report ${r.reportNumber} recorded.`) +
      dim(` (check-ins unchanged: ${r.checkInsCompleted})`),
  );
  if (r.clarification) {
    out(
      dim(
        `  Clarifies report ${r.clarification.clarifies.reportNumber}, ${r.clarification.clarifies.questionId}.` +
          (r.clarification.statusHoldResolved ? ' That answer no longer holds the experiment.' : '') +
          (r.clarification.restrictionKept ? ' Every restriction stays recorded.' : ''),
      ),
    );
  }
  if (r.statusHold && !r.safetyAction?.statusHold) out(dim(STATUS_HOLD_TEXT));
  printSafetyScreen(r.safety);
}

/** `supstack experiments check-in <id> [--answer id=value ...]` */
export async function runExperimentCheckIn(
  idOrPrefix: string,
  answerKvs: string[],
  asJson: boolean,
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);

  // No answers → show the check-in questions from the experiment's frozen protocol.
  if (answerKvs.length === 0) {
    const e = await getExperiment(id);
    const protocol = e.protocol as { checkIn?: { questions?: QuestionDoc[] } } | null;
    // Ruling 208 call 8: the server's list adds the current safety screen
    // (pregnancy status at every check-in) to the frozen protocol.
    const questions = (e.checkInQuestions ?? protocol?.checkIn?.questions ?? []).map((q) => ({
      ...q,
      // ⚠️ Recomputed from the FROZEN protocol, which carries no `required`
      // field — so the server's projection cannot be trusted here and the rule
      // has to be repeated. It must include `optional`, or the CLI prints
      // "(required)" beside a question whose own text says "leave blank if not
      // retested". The web forms and the API route were fixed first; this is
      // the fourth gate, and it was outside the parity probe's walk roots.
      // Owner decision 2026-10-05: every safety question is required at a check-in.
      required: (q.category === 'primary' && !q.optional) || isRequiredSafetyQuestion(q),
    }));
    if (asJson) {
      out(JSON.stringify({ checkInQuestions: questions }, null, 2));
      return;
    }
    renderQuestions(`Check-in #${e.progress.completed + 1} questions`, questions);
    if (e.safetyDisplay?.version) out(dim(`Safety text version: ${e.safetyDisplay.version}`));
    out();
    out(dim(`Submit with: supstack experiments check-in ${shortId(id)} --answer <id>=<value> ...`));
    return;
  }

  const answers = parseAnswers(answerKvs);
  let r: CheckInResult;
  try {
    r = await checkInExperiment(id, answers);
  } catch (err) {
    reportMissing(err);
  }
  if (asJson) {
    out(JSON.stringify({ checkIn: r }, null, 2));
    return;
  }
  printSafetyAction(r.safetyAction);
  if (r.status === 'completed') {
    out(green('Final check-in recorded.'));
    out(
      `  ${bold('Verdict')} ${verdictBadge(r.verdict ?? null)}${r.verdictSummary ? ` — ${r.verdictSummary}` : ''}`,
    );
  } else {
    out(
      green(`Check-in #${r.checkInNumber} recorded.`) +
        dim(` (${r.progress.completed}/${r.progress.expected})`),
    );
    if (r.nextCheckInDate) out(dim(`  Next check-in: ${date(r.nextCheckInDate)}`));
    if (r.statusHold && !r.safetyAction?.statusHold) out(dim(STATUS_HOLD_TEXT));
  }
  printSafetyScreen(r.safety);
}

interface AbandonResult {
  id: string;
  status: string;
  supplement: { slug: string; name: string };
  goal: { id: string; name: string };
  /** Pharmacist ruling 629: her W629, from the server. */
  safetyNote?: string;
}

/**
 * Pharmacist ruling 654 (22 October 2026), her W654, verbatim, shown before an
 * uninformed abandon. The app's ABANDON_BEFORE_654, held equal by
 * tests/lib/experiments/rulings-1022-a.test.ts.
 */
export const ABANDON_BEFORE_654 =
  'End this experiment? Its safety history will be kept. Ending it will not remove a safety restriction or authorize a new experiment with this product.';

export async function abandonExperiment(id: string, fetchImpl?: typeof fetch): Promise<AbandonResult> {
  const res = await apiPost<{ data: AbandonResult }>(
    `/me/experiments/${encodeURIComponent(id)}/abandon`,
    // Ruling 654: the caller has shown W654 (or the user asked to end it explicitly): the request says so.
    { confirm: true },
    { bearer: requireToken(), fetchImpl },
  );
  return res.data;
}

/** `supstack experiments abandon <id>` (accepts the short id from `list`) */
export async function runExperimentAbandon(
  idOrPrefix: string,
  asJson: boolean,
  informed = false,
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  // Ruling 654: W654 before an uninformed abandon. `--yes` is the informed command: it ends the experiment at once.
  if (!informed) {
    if (asJson)
      out(
        JSON.stringify(
          { abandoned: false, confirmationRequired: true, message: ABANDON_BEFORE_654 },
          null,
          2,
        ),
      );
    else {
      out(ABANDON_BEFORE_654);
      out(dim(`  Not ended. To end it, run: supstack experiments abandon ${idOrPrefix} --yes`));
    }
    return;
  }
  const r = await abandonExperiment(id);
  if (asJson) {
    out(JSON.stringify({ experiment: r }, null, 2));
    return;
  }
  out(yellow('Abandoned') + dim(` — ${r.supplement.name} × ${r.goal.name} (won't count toward a verdict).`));
  // Pharmacist ruling 629 (19 October 2026): her W629, as the server sends it.
  if (r.safetyNote) out(r.safetyNote);
}

// ─── Correction and status-hold release (rulings 239 and 241 call 1) ───────

/** The answer a person affirms for a correction, verbatim from the app (selection-correction.ts). */
export const CORRECTION_AFFIRMATION =
  'I chose this answer by mistake. None of these symptoms or events happened, and I have none of them now. This corrects my answer. It is not a clinical review.';

/**
 * Pharmacist ruling 571 (19 October 2026), her W571, verbatim from the app
 * (selection-correction.ts, held equal by test): the affirmation when only
 * some values of an answer are corrected. The values removed are listed
 * immediately above it.
 */
export const PARTIAL_CORRECTION_AFFIRMATION_571 =
  'I selected the answers listed above by mistake. Those symptoms or events did not happen. I am correcting only those listed answers. Any other symptoms, events and restrictions remain recorded.';

/** Ruling 571: an --answer that keeps a value (anything but none or no) corrects only some values of that answer. */
export function keepsSomeValues(answers: Record<string, string>): boolean {
  return Object.values(answers).some((v) =>
    v
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .some((x) => x !== '' && x !== 'none' && x !== 'no'),
  );
}

export interface CorrectionResult {
  id: string;
  status: string;
  statusHoldReleased?: boolean;
  corrected?: boolean;
  notClinicalClearance?: boolean;
  nextCheckInDate?: string | null;
  /** Ruling 281 call 2: false when the correction is stored but another event or answer keeps the pause. */
  released?: boolean;
  remainingHolds?: number;
  closedEvents?: string[];
  note?: string;
  /** Ruling 281 R14: what a correction is and is not. */
  correctionScope?: string;
}

/**
 * `POST /me/experiments/:id/correction`. A status hold: `{ renewedScreen }`.
 * A submitted answer chosen by mistake: `{ checkInNumber, correctedAnswers,
 * renewedScreen, affirmedNoEvent: true }`. Refusals (409) carry
 * `safetyAction` / `problems` outside `data`, read from the ApiError body.
 */
export async function postCorrection(
  id: string,
  body: {
    renewedScreen: Record<string, string>;
    checkInNumber?: number;
    correctedAnswers?: Record<string, string>;
    affirmedNoEvent?: boolean;
    /** Ruling 281 call 2: only these open safety events. */
    eventIds?: string[];
    /** Ruling 706: the saved safety report whose answers were entered by mistake. */
    reportNumber?: number;
  },
  fetchImpl?: typeof fetch,
): Promise<CorrectionResult> {
  const res = await withUnknownOutcome('correction', id, () =>
    apiPost<{ data: CorrectionResult }>(`/me/experiments/${encodeURIComponent(id)}/correction`, body, {
      bearer: requireToken(),
      fetchImpl,
    }),
  );
  return res.data;
}

/** Print a refused correction or release: the instruction first, then why. */
function reportCorrectionRefusal(err: unknown): never {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const b = err.body as {
      error?: string;
      message?: string;
      safetyAction?: SafetyAction;
      problems?: string[];
      pendingAnswer?: { heading?: string; instruction?: string };
      eligibility?: string;
      affirmation?: string;
      removedValues?: string[];
    };
    if (b.safetyAction) printSafetyAction(b.safetyAction);
    // Pharmacist ruling 410 (10 October 2026): the open check-in's saved answer
    // carries its routed instruction (the event's own action and next-dose
    // guidance). Show it before the note, as the web panel does.
    else if (b.pendingAnswer?.instruction) {
      if (b.pendingAnswer.heading) process.stderr.write(bold(b.pendingAnswer.heading) + '\n');
      process.stderr.write(b.pendingAnswer.instruction + '\n');
    }
    if (b.message) process.stderr.write(yellow(b.message) + '\n');
    if (b.eligibility) process.stderr.write(b.eligibility + '\n');
    // The raw problem codes are not an explanation (ruling 562): `message` is the reviewed text, `--json` keeps `problems`.
    // Ruling 571: the values a partial correction removes, immediately above her W571.
    if (b.removedValues?.length && b.affirmation) {
      for (const v of b.removedValues) process.stderr.write(`  - ${v}\n`);
      process.stderr.write(`  ${b.affirmation}\n`);
    }
  }
  throw err;
}

/**
 * `supstack experiments clarify-status <id> --screen id=value ...`
 * (pharmacist ruling 239). Answers the check-in screen again with a definite
 * pregnancy status. No clinician record is needed for a status hold, but a
 * confirmed pregnancy re-runs the product's pregnancy gate, which can turn
 * the hold into a safety pause.
 */
export async function runExperimentClarifyStatus(
  idOrPrefix: string,
  screenKvs: string[],
  asJson: boolean,
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  if (screenKvs.length === 0) {
    const e = await getExperiment(id);
    const screen = (e.checkInQuestions ?? []).filter((q) => q.category === 'safety');
    renderQuestions('Answer the screen again (the warning signs and the pregnancy status)', screen);
    out();
    out(dim(`Submit with: supstack experiments clarify-status ${shortId(id)} --screen <id>=<value> ...`));
    return;
  }
  let r: CorrectionResult;
  try {
    r = await postCorrection(id, { renewedScreen: parseAnswers(screenKvs) });
  } catch (err) {
    reportCorrectionRefusal(err);
  }
  if (asJson) {
    out(JSON.stringify({ experiment: r }, null, 2));
    return;
  }
  out(green('Hold released. The experiment carries on.'));
  if (r.nextCheckInDate) out(dim(`  Next check-in: ${date(r.nextCheckInDate)}`));
}

/**
 * `supstack experiments correct <id> --check-in N --answer id=value ...
 * --screen id=value ... --affirm` (pharmacist rulings 221 call 2 and 241
 * call 1). Corrects a check-in's answer chosen by mistake: a SUBMITTED one,
 * or one chosen in a check-in that was not submitted (`--check-in` the one
 * being answered), with the screen answered again and the affirmation. Ruling
 * 281 call 2: only the answers named with --answer (and the events named with
 * --event) are corrected; another answer or event that still holds the pause
 * keeps it, and the correction is still recorded. A data correction, never a
 * clinical clearance.
 */
export async function runExperimentCorrect(
  idOrPrefix: string,
  opts: {
    checkIn?: number;
    answers: string[];
    screen: string[];
    affirm: boolean;
    eventIds?: string[];
    report?: number;
  },
  asJson: boolean,
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  if (!opts.affirm) {
    // Ruling 571: a correction that keeps some values is affirmed with her W571, for the values it removes.
    throw new Error(
      keepsSomeValues(parseAnswers(opts.answers))
        ? `Pass --affirm only if this is true of the values you are removing (the values of that answer left out of --answer): "${PARTIAL_CORRECTION_AFFIRMATION_571}" A real or uncertain symptom is not a mistake: it needs the restart record.`
        : `Pass --affirm only if this is true: "${CORRECTION_AFFIRMATION}" A real or uncertain symptom is not a mistake: it needs the restart record.`,
    );
  }
  // Ruling 706: an answer saved in a safety report, named by the report's own number.
  const reportNumber = opts.report;
  if (reportNumber !== undefined && (!Number.isInteger(reportNumber) || reportNumber < 1)) {
    throw new Error(
      '--report takes the number of a saved safety report (see `supstack experiments report <id>`).',
    );
  }
  if (reportNumber === undefined && (!Number.isInteger(opts.checkIn) || (opts.checkIn ?? 0) < 1)) {
    throw new Error(
      'Pass --check-in <N>: the check-in that paused it, submitted or being answered (see `supstack experiments show`).',
    );
  }
  let r: CorrectionResult;
  try {
    r = await postCorrection(id, {
      ...(reportNumber !== undefined ? { reportNumber } : { checkInNumber: opts.checkIn }),
      correctedAnswers: parseAnswers(opts.answers),
      renewedScreen: parseAnswers(opts.screen),
      affirmedNoEvent: true,
      ...(opts.eventIds && opts.eventIds.length > 0 ? { eventIds: opts.eventIds } : {}),
    });
  } catch (err) {
    reportCorrectionRefusal(err);
  }
  if (asJson) {
    out(JSON.stringify({ experiment: r }, null, 2));
    return;
  }
  // Ruling 709: the server's saved text with the real state (a report correction).
  const savedText = (r as { saved?: string }).saved;
  if (r.released === false) {
    out(
      yellow('Correction recorded. The experiment stays paused.') +
        dim(' A data correction, not a clinical review.'),
    );
    if (r.note) out(`  ${r.note}`);
    if (typeof r.remainingHolds === 'number') out(dim(`  Still holding it: ${r.remainingHolds}`));
    if (r.correctionScope) out(dim(`  ${r.correctionScope}`));
    if (savedText) out(dim(`  ${savedText}`));
    return;
  }
  if (savedText) out(dim(`  ${savedText}`));
  out(green('Corrected as a mistake.') + dim(' A data correction, not a clinical review.'));
  if (r.correctionScope) out(dim(`  ${r.correctionScope}`));
  if (r.nextCheckInDate) out(dim(`  Next check-in: ${date(r.nextCheckInDate)}`));
}

// ─── Restart after a safety pause (rulings 198, 221, 240 and 261) ──────────

export interface RestartResult {
  id: string;
  status: string;
  restartRecordStored?: boolean;
  restartBasis?: string;
  nextCheckInDate?: string | null;
  note?: string;
  /** Ruling 280: the pregnancy and/or lactation plans stored with this restart. */
  populationPlansStored?: string[];
}

/** The restart record, the reader's own account. Field names as the API takes them. */
export interface RestartRecordBody {
  reviewerRole?: string;
  reviewedOn?: string;
  dose?: string;
  productForm?: string;
  restartPlan?: string;
  clinicianAdvisedRestart?: boolean;
  clearanceReference?: string;
  seriousInjury?: string;
  seriousIllness?: string;
  eventResolution?: string;
  /** Rulings 355 and 356: for a suspected illness, the clinician completed a safety assessment that clears this exact product. */
  illnessAssessmentComplete?: boolean;
  otherExposures?: string;
  maternityAssessed?: boolean;
  pregnancyPlan?: string;
  /** Ruling 281 call 1: one decision per illness the pause names. */
  seriousIllnessBy?: Record<string, string>;
  /** Ruling 281 call 1: one answer, confirmed for the complete named set. */
  seriousIllnessAppliesToAll?: boolean;
  /** Ruling 293/T3: confirmed-culprit (never restarted), ruled-out, suspected or not-assessed (both stay excluded pending specialist assessment). */
  sjsTen?: string;
  /** Ruling 280: the dedicated pregnancy and/or lactation plans recorded now. */
  populationPlans?: unknown[];
  /** Ruling 280: the exact regimen restarted on, compared with the plan on record. */
  currentRegimen?: unknown;
  /** Ruling 280: the current breastfeeding context, compared with the plan on record. */
  currentLactation?: unknown;
}

/**
 * Ruling 281 call 1: `--serious-illness excluded` is one answer; repeated
 * `--serious-illness kidney=excluded --serious-illness serious=excluded` is one
 * per named illness. Mixing both keeps the per-illness ones.
 */
export function seriousIllnessFromFlags(
  values: string[],
): Pick<RestartRecordBody, 'seriousIllness' | 'seriousIllnessBy'> {
  const by: Record<string, string> = {};
  let single: string | undefined;
  for (const v of values) {
    const i = v.indexOf('=');
    if (i > 0) by[v.slice(0, i).trim()] = v.slice(i + 1).trim();
    else if (v.trim()) single = v.trim();
  }
  return {
    ...(Object.keys(by).length > 0 ? { seriousIllnessBy: by } : {}),
    ...(single ? { seriousIllness: single } : {}),
  };
}

function readJsonFile(path: string, flag: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`${flag}: cannot read ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${flag}: ${path} is not JSON`);
  }
}

/**
 * Ruling 280: the plan files. `--plan-file` holds one plan, a list, or
 * `{ "populationPlans": [...] }`; the other two hold the object itself.
 */
export function planFilesFromFlags(f: {
  planFile?: string;
  currentRegimenFile?: string;
  currentLactationFile?: string;
}): Pick<RestartRecordBody, 'populationPlans' | 'currentRegimen' | 'currentLactation'> {
  const out: Pick<RestartRecordBody, 'populationPlans' | 'currentRegimen' | 'currentLactation'> = {};
  if (f.planFile) {
    const j = readJsonFile(f.planFile, '--plan-file');
    const list =
      j &&
      typeof j === 'object' &&
      !Array.isArray(j) &&
      Array.isArray((j as { populationPlans?: unknown }).populationPlans)
        ? (j as { populationPlans: unknown[] }).populationPlans
        : Array.isArray(j)
          ? j
          : [j];
    out.populationPlans = list;
  }
  if (f.currentRegimenFile) out.currentRegimen = readJsonFile(f.currentRegimenFile, '--current-regimen-file');
  if (f.currentLactationFile)
    out.currentLactation = readJsonFile(f.currentLactationFile, '--current-lactation-file');
  return out;
}

/**
 * `POST /me/experiments/:id/restart` with `{ renewedScreen, restartRecord }`.
 * Refusals (409) carry `restartRecordProblems` / `safetyAction` outside
 * `data`, read from the ApiError body.
 */
export async function postRestart(
  id: string,
  body: { renewedScreen: Record<string, string>; restartRecord: RestartRecordBody },
  fetchImpl?: typeof fetch,
): Promise<RestartResult> {
  const res = await withUnknownOutcome('restart', id, () =>
    apiPost<{ data: RestartResult }>(`/me/experiments/${encodeURIComponent(id)}/restart`, body, {
      bearer: requireToken(),
      fetchImpl,
    }),
  );
  return res.data;
}

/** Print a refused restart: the instruction first, then what the record lacks. */
function reportRestartRefusal(err: unknown): never {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const b = err.body as {
      message?: string;
      safetyAction?: SafetyAction;
      restartRecordProblems?: string[];
      renewedScreenQuestions?: string[];
      updateAnswer?: { how?: string };
      restartMustRecordExcluded?: string[];
      populationPlansRequired?: { kind: string; reason: string }[];
      heldExperiment?: { message?: string };
      amountDecimalComma?: string;
      eligibility?: string;
      clarificationQuestion?: { id: string; label?: string; options?: { value: string; label: string }[] };
      followUpQuestions?: { id: string; options?: { value: string; label: string }[] }[];
    };
    if (b.safetyAction) printSafetyAction(b.safetyAction);
    // Ruling 505: an app-hold refusal (`refusal`) is printed action first by printError; not twice here.
    if (b.message && !(b as { refusal?: unknown }).refusal) process.stderr.write(yellow(b.message) + '\n');
    // Pharmacist ruling 381: the complete restart rule, as the API states it.
    if (b.eligibility) process.stderr.write(b.eligibility + '\n');
    // Ruling 562: the API's `message` already lists each unmet requirement in her reviewed text. The raw problem codes stay in `--json` only.
    // Ruling 281 call 1: the complete named set, so one answer can be confirmed for all of it.
    if (b.restartMustRecordExcluded?.length)
      process.stderr.write(
        dim(
          `  Illnesses this pause names: ${b.restartMustRecordExcluded.join(', ')}. Answer each with --serious-illness <illness>=<decision>, or one with --applies-to-all.`,
        ) + '\n',
      );
    if (b.populationPlansRequired?.length)
      process.stderr.write(
        dim(
          `  Plans needed: ${b.populationPlansRequired.map((p) => `${p.kind} (${p.reason})`).join(', ')}. Record them with --plan-file, or compare with --current-regimen-file.`,
        ) + '\n',
      );
    if (b.heldExperiment?.message) process.stderr.write(dim(`  ${b.heldExperiment.message}`) + '\n');
    // Ruling 299 call 4: a decimal comma is refused with a dot example, never read.
    if (b.amountDecimalComma) process.stderr.write(yellow(`  ${b.amountDecimalComma}`) + '\n');
    if (b.renewedScreenQuestions?.length)
      process.stderr.write(dim(`  Screen questions: ${b.renewedScreenQuestions.join(', ')}`) + '\n');
    if (b.updateAnswer?.how) process.stderr.write(dim(`  ${b.updateAnswer.how}`) + '\n');
    // Ruling 727 (22 October 2026): her label for the clarification action, and
    // how to answer it from the CLI (the server's message already holds W616).
    // Item 726 (22 October 2026): her answer 2 or 3 asks the check-in's own safety questions first (the
    // server's message has their text); each is answered with --screen <id>=<value>.
    for (const q of b.followUpQuestions ?? []) {
      process.stderr.write(
        dim(`  --screen ${q.id}=<${(q.options ?? []).map((o) => o.value).join('|')}>`) + '\n',
      );
    }
    if (b.clarificationQuestion) {
      const c = b.clarificationQuestion;
      process.stderr.write(
        dim(
          `  ${c.label ?? 'Clarify your earlier plant-sterol answer'}: --screen ${c.id}=<${(c.options ?? []).map((o) => o.value).join('|')}>`,
        ) + '\n',
      );
    }
  }
  throw err;
}

/**
 * `supstack experiments restart <id> --screen id=value ... --reviewer doctor
 * --reviewed-on YYYY-MM-DD --dose ... --form ... --plan ... --advised ...`.
 * Restarts an experiment paused for safety with the restart record (your own
 * account, not verified), after answering the screen again. No flags shows
 * what it needs. The same checks as the web form and the assistant.
 */
export async function runExperimentRestart(
  idOrPrefix: string,
  opts: { screen: string[]; record: RestartRecordBody },
  asJson: boolean,
): Promise<void> {
  const id = await resolveExperimentId(idOrPrefix);
  if (opts.screen.length === 0) {
    const e = await getExperiment(id);
    printSafetyAction(e.safetyAction);
    // Owner call O-6: no record restarts a held experiment, so its refusal
    // is shown and no record is asked for.
    if (e.held === true && printHeldRefusal(e.heldRefusal)) return;
    if (e.restartRequires)
      outRestartRequirement(e.restartRequires, e.restartRequirementText, e.restartRequirementTextVersion);
    const screen = (e.checkInQuestions ?? []).filter((q) => q.category === 'safety');
    renderQuestions(
      'Answer the screen again first (the warning signs, the pregnancy and breastfeeding status)',
      screen,
    );
    out();
    out(
      dim(
        `Submit with: supstack experiments restart ${shortId(id)} --screen <id>=<value> ... --reviewer <role> --reviewed-on YYYY-MM-DD --dose "..." --form "..." --plan "..." --serious-injury <excluded|confirmed|suspected-or-unresolved|not-discussed> --serious-illness <illness>=<decision> ... --resolution <resolved|stable|not-resolved> --other-exposures "..." --advised` +
          (e.safetyAction?.restartMustRecordExcluded?.length
            ? ` (illnesses named: ${e.safetyAction.restartMustRecordExcluded.join(', ')})`
            : '') +
          (e.safetyAction?.restartMustRecordExcluded?.includes('skin')
            ? ' --sjs-ten <confirmed-culprit|ruled-out|suspected|not-assessed>'
            : '') +
          (e.safetyAction?.populationPlansRequired?.length ? ' --plan-file plans.json' : ''),
      ),
    );
    return;
  }
  let r: RestartResult;
  try {
    r = await postRestart(id, { renewedScreen: parseAnswers(opts.screen), restartRecord: opts.record });
  } catch (err) {
    reportRestartRefusal(err);
  }
  if (asJson) {
    out(JSON.stringify({ experiment: r }, null, 2));
    return;
  }
  out(green('Restarted.') + dim(' Your restart record is stored (your own account, not verified).'));
  if (r.populationPlansStored?.length) out(dim(`  Plan recorded: ${r.populationPlansStored.join(', ')}`));
  if (r.nextCheckInDate) out(dim(`  Next check-in: ${date(r.nextCheckInDate)}`));
  if (r.note) out(dim(`  ${r.note}`));
}
