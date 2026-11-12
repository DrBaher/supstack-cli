/**
 * The words for a side effect's `frequency` and `severity` in the terminal and
 * in MCP text. The API sends the stored tokens: `very-rare` (ruling 856, 10
 * November 2026), `rare`, `uncommon`, `common`, `unknown`, and `mild`,
 * `moderate`, `severe`, `not-established` (ruling 855, same day).
 *
 * `unknown` and `not-established` mean the source did not say. They must never
 * print as `rare` or `mild`, and a token this client does not know prints as not
 * established too, so an older client given a newer API value degrades to the
 * cautious reading instead of an invented one. Labels in English, her wording
 * verbatim where she gave it.
 */

export const FREQUENCY_LABELS: Readonly<Record<string, string>> = {
  'very-rare': 'Very rare (fewer than 1 in 10,000 people)',
  rare: 'Rare',
  uncommon: 'Uncommon',
  common: 'Common',
  unknown: 'Frequency not established',
};

export const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
  'not-established': 'Severity not established',
};

export const SEVERITY_NOT_ESTABLISHED_NOTE =
  'The available source did not grade how severe these reactions were. This does not mean they were mild.';

export function frequencyLabel(v: string): string {
  return FREQUENCY_LABELS[v] ?? FREQUENCY_LABELS.unknown!;
}

export function severityLabel(v: string): string {
  return SEVERITY_LABELS[v] ?? SEVERITY_LABELS['not-established']!;
}

/** True when the severity token is a graded one this client knows. */
export function isGraded(v: string): boolean {
  return v === 'mild' || v === 'moderate' || v === 'severe';
}
