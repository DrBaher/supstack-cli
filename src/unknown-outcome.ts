import { ApiError } from './http';

/**
 * Failed saves and unknown states (the pharmacist, 10 November 2026, rows 3 and 9). The CLI sends check-in, restart, correction and dose-log
 * requests once, with no retry (`apiPost` never resubmits), so when the response is lost (a timeout or a network error) the client cannot
 * know whether the server saved it. Her texts, verbatim, held equal to the app's `UPDATE_OUTCOME_UNKNOWN_750` and
 * `DOSE_ENTRY_UNKNOWN_1110` by tests/lib/experiments/failed-saves-1110.test.ts.
 */
export const UPDATE_OUTCOME_UNKNOWN_750 =
  'We could not confirm whether this update was saved. Refresh the record before trying again.';
export const DOSE_ENTRY_UNKNOWN_1110 =
  'We could not confirm whether this dose entry was saved. Check the dose history before trying again.';

export type UnknownOutcomeAction = 'check-in' | 'restart' | 'correction' | 'dose-log';

const TEXT: Record<UnknownOutcomeAction, string> = {
  'check-in': UPDATE_OUTCOME_UNKNOWN_750,
  restart: UPDATE_OUTCOME_UNKNOWN_750,
  correction: UPDATE_OUTCOME_UNKNOWN_750,
  'dose-log': DOSE_ENTRY_UNKNOWN_1110,
};

/**
 * The original network or timeout error (status 0, message unchanged, so the exit code and the printed error line stay as they were)
 * plus what the reader must be told: the outcome is unknown, never saved and never failed. `readBack` names the request, so a later
 * read can be matched to it (an unrelated later status does not answer it).
 */
export class UnknownOutcomeError extends ApiError {
  public readonly outcome = 'unknown' as const;
  public readonly outcomeText: string;
  public readonly readBack: {
    action: UnknownOutcomeAction;
    experimentId: string | null;
    attemptedAt: string;
    readWith: string;
  };
  constructor(
    cause: ApiError,
    action: UnknownOutcomeAction,
    experimentId: string | null,
    now: Date = new Date(),
  ) {
    super(cause.status, cause.message, cause.body);
    this.name = 'UnknownOutcomeError';
    this.outcomeText = TEXT[action];
    this.readBack = {
      action,
      experimentId,
      attemptedAt: now.toISOString(),
      readWith: action === 'dose-log' ? 'supstack track adherence' : 'supstack experiments show',
    };
  }
}

/**
 * Run one non-idempotent request. A lost response (status 0: timeout or network error) becomes an `UnknownOutcomeError`. Any other error,
 * including a 5xx the server answered, passes through unchanged: the server said what happened.
 */
export async function withUnknownOutcome<T>(
  action: UnknownOutcomeAction,
  experimentId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && err.status === 0 && !(err instanceof UnknownOutcomeError)) {
      throw new UnknownOutcomeError(err, action, experimentId);
    }
    throw err;
  }
}
