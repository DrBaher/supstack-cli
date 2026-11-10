import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed } from './http';
import { bold, cyan, dim, green, yellow } from './output';

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
  /**
   * ⚠️ MIRRORS `RecommendWarning` IN THE API (src/lib/recommend.ts). This
   * declared `severity: string` while the contract emits `severity: null,
   * ungraded: true` for a row nobody graded — so the client's type said a grade
   * always exists, and `atLeastModerate(null)` then decided how to render one.
   *
   * The 2026-09-06 recheck: "Runtime happens to show null as an unknown
   * severity, but the contract is wrong and no real ungraded recommendation test
   * crosses the route into this consumer." Both halves are fixed — the union
   * here, and the composition test in ungraded-composition.test.ts.
   */
  warnings: ({ type: string; message: string } & (
    | { severity: 'info' | 'mild' | 'moderate'; ungraded?: false }
    | { severity: null; ungraded: true }
  ))[];
  /** Why this row was lifted for the caller's diet, when it was. */
  dietConcern?: { diet: string; message: string };
}

interface RecommendData {
  recommendations: Recommendation[];
  meta: {
    goals: { id: string; name: string }[];
    stack: string[];
    totalRecommendations: number;
    /**
     * How many relevant candidates the API withheld because the caller is
     * 13-17 and the entry does not assess that age (ruling 175), and the
     * sentence to show when that is above zero. Optional: an older API omits
     * both (owner decision 2026-10-05).
     */
    withheldForAge?: number;
    teenNotice?: string | null;
    /**
     * Ruling 197.3: a medication no interaction row covers, named with the
     * pharmacist route (null when every one is covered). Ruling 197.2: notices
     * about a medicine the caller takes. Optional: an older API omits them.
     */
    coverageNotice?: string | null;
    medicineNotices?: string[];
    /**
     * Owner decision 4 (6 October 2026): entries the dose-form gate held back
     * (red yeast rice, vitamin E) until a product's dose and form are recorded,
     * each with the sentence to show and the profile link. Optional: an older
     * API omits it.
     */
    heldForRegimen?: {
      slug: string;
      reason: string;
      sources: string[];
      notice: string;
      url: string | null;
    }[];
  };
}

/**
 * Show a warning at `moderate` OR ANYTHING ABOVE IT.
 *
 * This was `w.severity === 'moderate'`, an equality check against what happens
 * to be the top of the API's current scale (`info | mild | moderate`) — so it
 * hid nothing today, and would silently hide the WORST warnings the moment the
 * API gained a higher severity. An unknown severity is shown rather than
 * dropped: on a safety surface, the failure mode of a value this client does not
 * recognise has to be noisy, not quiet.
 */
const SEVERITY_ORDER = ['info', 'mild', 'moderate'];

function atLeastModerate(severity: string): boolean {
  const rank = SEVERITY_ORDER.indexOf(severity);
  return rank === -1 || rank >= SEVERITY_ORDER.indexOf('moderate');
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

  // The teen notice, verbatim from the API. With an empty list it replaces
  // "no recommendations cleared the bar", which would be false for this reader.
  const teenNotice = (meta.withheldForAge ?? 0) > 0 ? meta.teenNotice : null;
  if (teenNotice) out(teenNotice);
  // Rulings 197.3 and 197.2: about the caller's medicines, not any one
  // recommendation, so printed once above the list.
  for (const line of [meta.coverageNotice, ...(meta.medicineNotices ?? [])]) {
    if (line) out(yellow(line));
  }
  // Owner decision 4: what the dose-form gate held back, verbatim from the API.
  const held = meta.heldForRegimen ?? [];
  for (const h of held) out(h.notice);

  if (recommendations.length === 0) {
    if (!teenNotice && held.length === 0) out(dim('No recommendations cleared the bar right now.'));
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
    // A reason, not a warning: the API lifted this row for the caller's diet
    // and says why. Rendered unconditionally — a score that moved with no
    // visible cause is the round-48 shape.
    if (r.dietConcern) out(`  ${green('✚')} ${dim(r.dietConcern.message)}`);
    for (const w of r.warnings) {
      /**
       * ⚠️ KIND FIRST, THEN RANK.
       *
       * `unchecked-axis` says the API could not check something — `beta-carotene`
       * for a profile that never stated a smoking status — and it is honestly
       * `severity: 'info'`, because an unanswered question is not a finding.
       * That put it below the `moderate` cut, so this loop dropped the one
       * warning whose entire purpose is telling the reader that silence here is
       * not a clean bill of health.
       *
       * Ranking is right for findings. A thing nobody looked at is not one, and
       * neither is a statement about how strong the evidence behind a warning
       * is — `evidence-grade` joined this branch for the same reason and was
       * dropped the same way before anyone noticed.
       */
      if (w.type === 'unchecked-axis' || w.type === 'evidence-grade') {
        out(`  ${dim('○')} ${dim(w.message)}`);
      } else if (w.severity === null) {
        /**
         * ⚠️ UNGRADED BEFORE RANKED, because ranking is the thing that must not
         * happen here. `atLeastModerate(null)` returns true via the unknown-
         * severity escape hatch, so an ungraded row rendered as `yellow('⚠')` —
         * visually identical to a graded moderate finding. It was shown, which
         * is right, but shown AS a grade, which is not.
         *
         * The marker is the one already used for "looked at, not a finding",
         * and the label states the reason rather than implying a tier.
         */
        out(`  ${dim('○')} ${dim(`${w.message} (not graded — awaiting review)`)}`);
      } else if (atLeastModerate(w.severity)) {
        out(`  ${yellow('⚠')} ${dim(w.message)}`);
      }
    }
  }
}
