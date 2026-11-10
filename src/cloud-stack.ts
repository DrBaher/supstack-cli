import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';

export interface CloudStackItem {
  slug: string;
  dosage: string | null;
  timing: string | null;
  notes: string | null;
  brandName: string | null;
  position: number;
}

export interface CloudStack {
  stackId: string | null;
  name: string | null;
  supplements: CloudStackItem[];
}

/** Thrown when a cloud operation is attempted without an account token. */
export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run `supstack login` to sync your stack with your account.');
    this.name = 'NotLoggedInError';
  }
}

function requireToken(): string {
  const token = getToken();
  if (!token) throw new NotLoggedInError();
  return token;
}

/** Fetch the user's cloud stack. */
/**
 * ⚠️ Round 92 of the human persona audit. `/me/stack` returns
 * `meta.warnings` — the population and medication warnings the SERVER already
 * computed for this caller's stack — and this client typed the response as
 * `{ data }` and threw the rest away. The warnings never reached the rendering
 * layer, so a CLI user viewing their cloud stack was shown supplements the web
 * app would have flagged, silently.
 *
 * The CLI is a thin client over the public API; that is exactly why dropping a
 * field the API computed is a safety gap rather than a formatting choice.
 */
export interface StackWarning {
  slug: string;
  warnings: string[];
}

/**
 * What the server says about the caller's MEDICINES, once per response rather
 * than per supplement: ruling 197.3's catalogue-coverage sentence (a medicine
 * no row covers, such as pamidronate) and ruling 197.2's medicine notices (the
 * kidney precaution before each injected bisphosphonate dose). The CLI printed
 * `coverageNotice` on `interactions` only, and dropped both here.
 */
export interface MedicineMeta {
  coverageNotice?: string;
  medicineNotices?: string[];
}

/** Only the two medicine fields, so nothing else from `meta` rides along by accident. */
export function medicineMetaOf(meta: MedicineMeta | undefined): MedicineMeta {
  return {
    ...(meta?.coverageNotice ? { coverageNotice: meta.coverageNotice } : {}),
    ...(meta?.medicineNotices?.length ? { medicineNotices: meta.medicineNotices } : {}),
  };
}

export async function getCloudStack(fetchImpl?: typeof fetch): Promise<CloudStack> {
  const res = await apiGetAuthed<{ data: CloudStack }>('/me/stack', requireToken(), { fetchImpl });
  return res.data;
}

/** The same fetch, keeping the server's warnings. */
export async function getCloudStackWithWarnings(
  fetchImpl?: typeof fetch,
): Promise<{ stack: CloudStack; warnings: StackWarning[] } & MedicineMeta> {
  const res = await apiGetAuthed<{ data: CloudStack; meta?: { warnings?: StackWarning[] } & MedicineMeta }>(
    '/me/stack',
    requireToken(),
    { fetchImpl },
  );
  return { stack: res.data, warnings: res.meta?.warnings ?? [], ...medicineMetaOf(res.meta) };
}

/** An item to write to the cloud stack — slug plus optional metadata to preserve. */
export interface StackPutItem {
  slug: string;
  dosage?: string | null;
  timing?: string | null;
  notes?: string | null;
  brandName?: string | null;
}

/**
 * Replace the user's cloud stack with `items`. Pass full items (not bare slugs)
 * so existing dosage/timing/brand metadata is preserved across a sync/push —
 * the PUT replaces the whole stack, so anything omitted is lost.
 */
export async function putCloudStack(items: StackPutItem[], fetchImpl?: typeof fetch): Promise<CloudStack> {
  return (await putCloudStackWithMeta(items, fetchImpl)).stack;
}

/** What the server reports about a write it could not fully honour. */
export interface StackWriteMeta extends MedicineMeta {
  warnings: StackWarning[];
  /** Items beyond the server's cap — saved by neither the stack nor the screen. */
  droppedOverCap?: number;
  limit?: number;
  droppedOverCapNote?: string;
  /** Request positions the server could not parse. */
  droppedMalformed?: number[];
  droppedMalformedNote?: string;
  /** Slugs the server does not recognise. */
  droppedUnknown?: string[];
}

/**
 * The same PUT, keeping everything the server said about it.
 *
 * ⚠️ Round 148. Round 92 found this client typing `meta` and then throwing it
 * away on the READ, and fixed the read with `getCloudStackWithWarnings`. The
 * WRITE kept the original shape: it declared `meta?: { warnings }` and returned
 * `res.data`, so the annotation was decorative.
 *
 * Two things were therefore invisible to a CLI user running `stack push` or
 * `stack sync`:
 *
 *   the population and medication warnings the server computes on the write —
 *   round 92's bug exactly, on the other verb;
 *
 *   and round 140's `droppedOverCap` / `droppedMalformed`, added six rounds ago
 *   precisely so a caller would learn that part of their stack was neither
 *   stored NOR safety-checked. The server started saying it; nothing listened.
 */
export async function putCloudStackWithMeta(
  items: StackPutItem[],
  fetchImpl?: typeof fetch,
): Promise<{ stack: CloudStack; meta: StackWriteMeta }> {
  const res = await apiPost<{ data: CloudStack; meta?: Partial<StackWriteMeta> }>(
    '/me/stack',
    { supplements: items },
    { bearer: requireToken(), method: 'PUT', fetchImpl },
  );
  return { stack: res.data, meta: { ...res.meta, warnings: res.meta?.warnings ?? [] } };
}
