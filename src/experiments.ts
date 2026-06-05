import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed } from './http';
import { bold, cyan, dim, yellow } from './output';

export interface ExperimentListItem {
  id: string;
  supplement: { slug: string; name: string };
  goal: { id: string; name: string };
  status: string;
  verdict: string | null;
  verdictSummary: string | null;
  progress: { completed: number; expected: number };
  startedAt: string | null;
  completedAt: string | null;
  nextCheckInDate: string | null;
}

interface ExperimentResponse {
  type: string;
  checkInNumber: number | null;
  questionId: string;
  questionText: string;
  category: string;
  value: unknown;
  respondedAt: string;
}

export interface ExperimentDetail extends ExperimentListItem {
  verdictDetails: unknown;
  protocol: unknown;
  baselineCompletedAt: string | null;
  responses: ExperimentResponse[];
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
        `  ${dim(`${e.progress.completed}/${e.progress.expected}`)}${verdict ? `  ${verdict}` : ''}`,
    );
  }
  out();
  out(dim('Show one with `supstack experiments show <id>`.'));
}

/** `supstack experiments show <id>` */
export async function runExperimentShow(id: string, asJson: boolean): Promise<void> {
  const e = await getExperiment(id);
  if (asJson) {
    out(JSON.stringify(e, null, 2));
    return;
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
  const checkIns = e.responses.filter((r) => r.type === 'check-in');
  if (checkIns.length) {
    out();
    out(bold('Check-ins'));
    for (const r of checkIns.slice(-12)) {
      const n = r.checkInNumber !== null ? `#${r.checkInNumber} ` : '';
      out(dim(`  ${n}${r.questionText}: `) + String(r.value));
    }
  }
}
