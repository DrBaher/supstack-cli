import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed } from './http';
import { bold, cyan, dim, yellow } from './output';

interface Recommendation {
  supplement: {
    id: string;
    slug: string;
    name: string;
    shortDescription?: string | null;
    evidence: { score?: number; level?: string };
    safety: { overallRating?: string };
  };
  scores: { composite: number };
  goalBreakdown: { goalId: string; goalName: string; relevanceScore: number; isPrimaryMatch: boolean }[];
  warnings: { type: string; severity: string; message: string }[];
}

interface RecommendData {
  recommendations: Recommendation[];
  meta: { goals: { id: string; name: string }[]; stack: string[]; totalRecommendations: number };
}

function requireToken(): string {
  const token = getToken();
  if (!token) throw new NotLoggedInError();
  return token;
}

/** Fetch personalized recommendations (from the user's saved goals + cloud stack). */
export async function getRecommendations(limit: number, fetchImpl?: typeof fetch): Promise<RecommendData> {
  const res = await apiGetAuthed<{
    data: { recommendations: Recommendation[] };
    meta: RecommendData['meta'];
  }>(`/me/recommend?limit=${encodeURIComponent(limit)}`, requireToken(), { fetchImpl });
  return { recommendations: res.data.recommendations, meta: res.meta };
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

/** `supstack recommend` — personalized recommendations. */
export async function runRecommend(limit: number, asJson: boolean): Promise<void> {
  const { recommendations, meta } = await getRecommendations(limit);

  if (asJson) {
    out(JSON.stringify({ recommendations, meta }, null, 2));
    return;
  }

  const basis = [
    meta.goals.length ? `goals: ${meta.goals.map((g) => g.name).join(', ')}` : '',
    meta.stack.length ? `stack of ${meta.stack.length}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  out(dim(`Personalized from your ${basis}.`));

  if (recommendations.length === 0) {
    out(dim('No recommendations cleared the bar right now.'));
    return;
  }

  out();
  for (const r of recommendations) {
    const ev = r.supplement.evidence;
    const evStr = ev.score !== undefined ? ` · evidence ${ev.score}/10` : '';
    out(
      `${bold(r.supplement.name)} ${dim(r.supplement.slug)}  ${cyan(`${r.scores.composite}/100`)}${dim(evStr)}`,
    );
    const primary = r.goalBreakdown.find((g) => g.isPrimaryMatch) ?? r.goalBreakdown[0];
    if (primary && primary.relevanceScore > 0) {
      out(dim(`  best for ${primary.goalName} (${primary.relevanceScore}% relevant)`));
    }
    for (const w of r.warnings) {
      if (w.severity === 'moderate') out(`  ${yellow('⚠')} ${dim(w.message)}`);
    }
  }
}
