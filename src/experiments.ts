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
        `  ${dim(`${e.progress.completed}/${e.progress.expected}`)}${verdict ? `  ${verdict}` : ''}`,
    );
  }
  out();
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
