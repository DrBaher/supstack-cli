import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { ApiError, apiGetAuthed, apiPost } from './http';
import { bold, cyan, dim, green, yellow } from './output';

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

// ─── Write: protocol preview, start, check-in ────────────────────────────

export interface QuestionDoc {
  id: string;
  text: string;
  type: string;
  category: string;
  required: boolean;
  unit?: string;
  scale?: { min: number; max: number; lowLabel?: string; highLabel?: string };
  range?: { min: number; max: number };
  options?: { value: string; label: string }[];
}

interface ProtocolPreview {
  supplement: { id: string; name: string; slug: string };
  goal: { id: string; name: string };
  dosing: { dose: string; timing: string };
  schedule: { totalCheckIns: number };
  baselineQuestions: QuestionDoc[];
  checkInQuestions: QuestionDoc[];
}

interface CreatedExperiment {
  id: string;
  supplement: { slug: string; name: string };
  goal: { id: string; name: string };
  status: string;
  progress: { completed: number; expected: number };
  startedAt: string;
  nextCheckInDate: string | null;
}

interface CheckInResult {
  id: string;
  status: string;
  checkInNumber: number;
  progress: { completed: number; expected: number };
  nextCheckInDate?: string | null;
  verdict?: string;
  verdictSummary?: string;
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
): Promise<CreatedExperiment> {
  const res = await apiPost<{ data: CreatedExperiment }>(
    '/me/experiments',
    { supplement, goal, answers },
    { bearer: requireToken(), fetchImpl },
  );
  return res.data;
}

export async function checkInExperiment(
  id: string,
  answers: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<CheckInResult> {
  const res = await apiPost<{ data: CheckInResult }>(
    `/me/experiments/${encodeURIComponent(id)}/check-in`,
    { answers },
    { bearer: requireToken(), fetchImpl },
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

function questionHint(q: QuestionDoc): string {
  if (q.type === 'scale' && q.scale) return dim(` [${q.scale.min}–${q.scale.max}]`);
  if (q.type === 'number' && q.range)
    return dim(` [${q.range.min}–${q.range.max}${q.unit ? ` ${q.unit}` : ''}]`);
  if (q.type === 'yesno') return dim(' [yes | no]');
  if (q.options?.length) return dim(` [${q.options.map((o) => o.value).join(' | ')}]`);
  return q.unit ? dim(` [${q.unit}]`) : '';
}

function renderQuestions(title: string, questions: QuestionDoc[]): void {
  out(bold(title));
  for (const q of questions) {
    const tag = q.required ? yellow(' (required)') : dim(' (optional)');
    out(`  ${cyan(q.id)}${tag}${questionHint(q)}`);
    out(dim(`    ${q.text}`));
  }
}

/** If a 400 carried a `missing` question list, print it; always rethrow. */
function reportMissing(err: unknown): never {
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
  out(dim(`  ${p.dosing.dose} · ${p.dosing.timing} · ${p.schedule.totalCheckIns} check-ins`));
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

/** `supstack experiments start <supplement> <goal> [--answer id=value ...]` */
export async function runExperimentStart(
  supplement: string,
  goal: string,
  answerKvs: string[],
  asJson: boolean,
): Promise<void> {
  // No answers → show the baseline questions to answer (don't create anything).
  if (answerKvs.length === 0) {
    await runExperimentProtocol(supplement, goal, asJson);
    return;
  }
  const answers = parseAnswers(answerKvs);
  let e: CreatedExperiment;
  try {
    e = await startExperiment(supplement, goal, answers);
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
    const questions = (protocol?.checkIn?.questions ?? []).map((q) => ({
      ...q,
      required: q.category === 'primary',
    }));
    if (asJson) {
      out(JSON.stringify({ checkInQuestions: questions }, null, 2));
      return;
    }
    renderQuestions(`Check-in #${e.progress.completed + 1} questions`, questions);
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
  }
}
