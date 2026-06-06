import { ZodError } from 'zod';

import { NotLoggedInError } from './cloud-stack';
import { ApiError } from './http';

/**
 * Process exit codes. Distinct codes let scripts and MCP wrappers branch on the
 * *kind* of failure without scraping stderr. Stable contract — documented in the
 * README; renumbering is a breaking change.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Generic / unclassified failure (also 5xx server errors). */
  ERROR: 1,
  /** Authentication required or rejected (not logged in, 401, 403). */
  AUTH: 2,
  /** The requested resource does not exist (404). */
  NOT_FOUND: 3,
  /** Rate limit hit (429). */
  RATE_LIMIT: 4,
  /** Network failure or timeout (no HTTP status). */
  NETWORK: 5,
  /** Invalid input — bad args or a 400/422 from the API. */
  INVALID_INPUT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Map a thrown error to a semantic exit code. Used by both the registry command
 * runner ([cli.ts](cli.ts)) and the hand-registered authed commands' top-level
 * catch ([index.ts](index.ts)) so every failure path exits with the same scheme.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof NotLoggedInError) return EXIT.AUTH;
  if (err instanceof ZodError) return EXIT.INVALID_INPUT;
  if (err instanceof ApiError) {
    switch (err.status) {
      case 0:
        return EXIT.NETWORK; // ApiError(0, …) is our network/timeout sentinel
      case 400:
      case 422:
        return EXIT.INVALID_INPUT;
      case 401:
      case 403:
        return EXIT.AUTH;
      case 404:
        return EXIT.NOT_FOUND;
      case 429:
        return EXIT.RATE_LIMIT;
      default:
        return EXIT.ERROR; // 5xx and anything else
    }
  }
  return EXIT.ERROR;
}
