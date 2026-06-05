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
export async function getCloudStack(fetchImpl?: typeof fetch): Promise<CloudStack> {
  const res = await apiGetAuthed<{ data: CloudStack }>('/me/stack', requireToken(), { fetchImpl });
  return res.data;
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
  const res = await apiPost<{ data: CloudStack }>(
    '/me/stack',
    { supplements: items },
    { bearer: requireToken(), method: 'PUT', fetchImpl },
  );
  return res.data;
}
