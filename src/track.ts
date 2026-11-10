import { type MedicineMeta, medicineMetaOf, NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, cyan, dim, green, yellow } from './output';
import { withUnknownOutcome } from './unknown-outcome';

interface TrackResult extends MedicineMeta {
  date: string;
  status: string;
  logged: number;
  supplements: string[];
  /**
   * ⚠️ Round 96. What the server knows about what was just logged. On the
   * result type, so `--json` and MCP consumers get it — an MCP client that logs
   * an intake for someone is exactly the channel that should relay "and this one
   * is flagged for you".
   */
  warnings?: TrackWarning[];
  /**
   * Pharmacist ruling 279 and item 1110 row 9: an experiment of a logged supplement holds the next optional dose, or its hold state could
   * not be read (`source: 'unreadable'`, with her dose-log text and one outcome line in `message`). Until 10 November 2026 the client dropped
   * this part of `meta`, so neither the CLI nor MCP ever relayed a hold on a dose log.
   */
  experimentHolds?: ExperimentHold[];
}

export interface ExperimentHold {
  experimentId?: string;
  supplement?: string;
  source: string;
  message: string;
  doseEntry?: 'saved' | 'not-saved' | 'unknown';
}

interface Adherence {
  days: number;
  scheduledDoses: number;
  takenDoses: number;
  rate: number; // 0..1
  streak: number;
  stackSize: number;
  perSupplement: { slug: string; takenDays: number; rate: number }[];
}

function requireToken(): string {
  const token = getToken();
  if (!token) throw new NotLoggedInError();
  return token;
}

/** Population/medication warnings for what was just logged. */
export interface TrackWarning {
  slug: string;
  warnings: string[];
}

export interface LogInput {
  supplement?: string;
  block?: string;
  date?: string;
  status?: 'taken' | 'skipped';
}

export async function logIntake(input: LogInput, fetchImpl?: typeof fetch): Promise<TrackResult> {
  // ⚠️ Round 96. `/me/track` returns `meta.warnings` — what the server knows
  // about what was just logged. Round 93 was this exact unwrap discarding
  // `meta` on the stack endpoint; recreating it one round after fixing it would
  // have been the fifth instance of a client lagging its server.
  const res = await withUnknownOutcome('dose-log', null, () =>
    apiPost<{
      data: TrackResult;
      meta?: { warnings?: TrackWarning[]; experimentHolds?: ExperimentHold[] } & MedicineMeta;
    }>('/me/track', input, {
      bearer: requireToken(),
      fetchImpl,
    }),
  );
  // Rulings 197.3 and 197.2: the coverage sentence and the medicine notices,
  // kept like the warnings so `--json` and MCP get them too.
  return {
    ...res.data,
    warnings: res.meta?.warnings ?? [],
    ...medicineMetaOf(res.meta),
    ...(res.meta?.experimentHolds?.length ? { experimentHolds: res.meta.experimentHolds } : {}),
  };
}

export async function getAdherence(days: number, fetchImpl?: typeof fetch): Promise<Adherence> {
  // Pass our LOCAL today so the server's window + streak align with the local
  // dates `track log` writes (avoids a TZ-boundary off-by-one).
  const res = await apiGetAuthed<{ data: Adherence }>(
    `/me/adherence?days=${days}&today=${encodeURIComponent(localToday())}`,
    requireToken(),
    { fetchImpl },
  );
  return res.data;
}

/** Local calendar date (YYYY-MM-DD) so a dose is logged for the user's day. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function bar(rate: number): string {
  // Clamp to [0,12]: a rate slightly >1 (e.g. takenDays briefly exceeding the
  // window after a backfill) must not feed `.repeat()` a negative count.
  const filled = Math.max(0, Math.min(12, Math.round(rate * 12)));
  return '█'.repeat(filled) + dim('░'.repeat(12 - filled));
}

/** `supstack track log [supplement]` */
export async function runTrackLog(
  supplement: string | undefined,
  opts: Record<string, unknown>,
  asJson: boolean,
): Promise<void> {
  const input: LogInput = {
    supplement,
    block: typeof opts.block === 'string' ? opts.block : undefined,
    date: typeof opts.date === 'string' ? opts.date : localToday(),
    status: opts.skip ? 'skipped' : 'taken',
  };
  const r = await logIntake(input);
  if (asJson) {
    out(JSON.stringify(r, null, 2));
    return;
  }
  const verb = r.status === 'skipped' ? 'Skipped' : 'Logged';
  if (r.logged === 1) {
    out(dim(`${verb} ${r.supplements[0]} for ${r.date}.`));
  } else {
    out(dim(`${verb} ${r.logged} supplements for ${r.date}: `) + r.supplements.join(', '));
  }
  // What the server flagged about what was just logged, in the shape `stack`
  // prints it. The result carried these since round 96, for `--json` and MCP,
  // and the terminal printed none of them.
  for (const w of r.warnings ?? []) {
    for (const line of w.warnings) out(`  ${yellow('⚠')} ${w.slug}: ${dim(line)}`);
  }
  // Ruling 279 and item 1110 row 9: the server's own hold text, as sent (her dose-log text and outcome line for an unreadable hold).
  for (const h of r.experimentHolds ?? []) {
    for (const line of String(h.message).split('\n')) if (line.trim() !== '') out(`  ${yellow('⚠')} ${line}`);
  }
  // Rulings 197.3 and 197.2: about the caller's medicines, once.
  for (const line of [r.coverageNotice, ...(r.medicineNotices ?? [])]) {
    if (line) out(`  ${yellow('⚠')} ${line}`);
  }
}

/** `supstack track adherence [--days N]` */
export async function runAdherence(days: number, asJson: boolean): Promise<void> {
  const a = await getAdherence(days);
  if (asJson) {
    out(JSON.stringify(a, null, 2));
    return;
  }
  if (a.stackSize === 0) {
    out(dim('Your stack is empty — add supplements (and `track log`) to measure adherence.'));
    return;
  }
  const pct = (r: number): string => `${Math.round(r * 100)}%`;
  out(bold(`Adherence`) + dim(` · last ${a.days} days`));
  const overall = a.rate >= 0.9 ? green(pct(a.rate)) : a.rate < 0.5 ? yellow(pct(a.rate)) : cyan(pct(a.rate));
  out(`  Overall   ${overall}  ${dim(`(${a.takenDoses}/${a.scheduledDoses} doses)`)}`);
  out(`  Streak    ${a.streak > 0 ? cyan(`${a.streak} day${a.streak === 1 ? '' : 's'}`) : dim('0 days')}`);
  out();
  out(dim('  By supplement (worst first)'));
  for (const s of a.perSupplement) {
    const r = pct(s.rate);
    const colored = s.rate < 0.5 ? yellow(r) : s.rate >= 0.9 ? green(r) : r;
    out(`    ${s.slug.padEnd(20)} ${bar(s.rate)} ${colored}`);
  }
}
