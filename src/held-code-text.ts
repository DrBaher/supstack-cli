/**
 * Item 1110 row 4 (the pharmacist, 10 November 2026): the human-readable `experiments list` shows her exact 748 code-lookup text beside the raw
 * refusal code of a held row. `--json` keeps the code only. The table is her sheet
 * docs/clinical-review/pharmacist-rulings-2026-11-10-follow-up-745-881/her-sheet-748-code-text-lookup.tsv, "API refusal code" rows, held
 * equal by tests/lib/experiments/failed-saves-1110.test.ts.
 *
 * Only a code a list row can carry is mapped: those `heldReasonCodes` (src/lib/experiments/restart-app-hold-read.ts) can return, and the
 * test derives that set from source. Her condition is that a text with a placeholder it cannot resolve is not used, so a code her sheet maps
 * but a list row cannot give the context for (a refusal that says "shown below", or needs the attempted operation) falls to her unknown line.
 */
export const HELD_CODE_TEXT: Readonly<Record<string, string>> = {
  app_restart_unavailable:
    'SupStack cannot restart this product for the recorded event. Follow the event-specific advice shown here and ask the treating clinician about your treatment.',
  permanently_excluded:
    'SupStack will not start or restart the product recorded as the confirmed cause of this serious reaction. Do not take it again to test the reaction. A restart plan does not remove this exclusion.',
  prior_safety_pause_restart_record_required:
    'This action was not completed because an earlier product restriction still needs a documented review. Open the earlier event and the requirements for this exact product.',
};

/** Her line for a code the lookup does not map, or a held row with no code. Never read as clear, eligible or resumed. */
export const HELD_CODE_UNINTERPRETED_1110 =
  'The safety status could not be interpreted. Check the safety record before starting or resuming an optional experiment.';

/** Her text for the code, or her unknown line. */
export function heldCodeText(code: string | undefined): string {
  return (
    (code !== undefined && Object.prototype.hasOwnProperty.call(HELD_CODE_TEXT, code)
      ? HELD_CODE_TEXT[code]
      : undefined) ?? HELD_CODE_UNINTERPRETED_1110
  );
}

/**
 * Her question 7 answer B (10 November 2026): the list row does not show the event advice, so it carries her list-row variant of
 * app_restart_unavailable. The full text above stays for a place that does show the event advice. Held equal to
 * src/data/code-texts-1110.ts by tests/lib/experiments/codes-1110.test.ts.
 */
export const APP_RESTART_UNAVAILABLE_LIST_1110 =
  'SupStack cannot restart this product for the recorded event. Use experiments show to read the event-specific safety advice, and ask the treating clinician about your treatment.';

/** The text for a held row in `experiments list`: her list-row variant where she gave one, otherwise as `heldCodeText`. */
export function heldCodeListText(code: string | undefined): string {
  return code === 'app_restart_unavailable' ? APP_RESTART_UNAVAILABLE_LIST_1110 : heldCodeText(code);
}
