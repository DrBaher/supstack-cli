import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, cyan, dim, yellow } from './output';

interface TrackResult {
  date: string;
  status: string;
  logged: number;
  supplements: string[];
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

export interface LogInput {
  supplement?: string;
  block?: string;
  date?: string;
  status?: 'taken' | 'skipped';
}

export async function logIntake(input: LogInput, fetchImpl?: typeof fetch): Promise<TrackResult> {
  const res = await apiPost<{ data: TrackResult }>('/me/track', input, { bearer: requireToken(), fetchImpl });
  return res.data;
}

export async function getAdherence(days: number, fetchImpl?: typeof fetch): Promise<Adherence> {
  const res = await apiGetAuthed<{ data: Adherence }>(`/me/adherence?days=${days}`, requireToken(), {
    fetchImpl,
  });
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
  const filled = Math.round(rate * 12);
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
  out(`  Overall   ${cyan(pct(a.rate))}  ${dim(`(${a.takenDoses}/${a.scheduledDoses} doses)`)}`);
  out(`  Streak    ${a.streak > 0 ? cyan(`${a.streak} day${a.streak === 1 ? '' : 's'}`) : dim('0 days')}`);
  out();
  out(dim('  By supplement (worst first)'));
  for (const s of a.perSupplement) {
    const r = pct(s.rate);
    const colored = s.rate < 0.5 ? yellow(r) : s.rate >= 0.9 ? cyan(r) : r;
    out(`    ${s.slug.padEnd(20)} ${bar(s.rate)} ${colored}`);
  }
}
