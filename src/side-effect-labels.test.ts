import { describe, expect, it } from 'vitest';

import { research } from './capabilities/research';
import { frequencyLabel, isGraded, SEVERITY_NOT_ESTABLISHED_NOTE, severityLabel } from './side-effect-labels';

/**
 * Rulings 855 and 856 (10 November 2026): the API sends `very-rare` and `not-established`. An older or newer client must never print
 * them as `rare` or `mild`, and a token it does not know prints as not established.
 */
describe('side-effect words', () => {
  it('very-rare is her label verbatim, and not-established severity is her label', () => {
    expect(frequencyLabel('very-rare')).toBe('Very rare (fewer than 1 in 10,000 people)');
    expect(severityLabel('not-established')).toBe('Severity not established');
    expect(SEVERITY_NOT_ESTABLISHED_NOTE).toBe(
      'The available source did not grade how severe these reactions were. This does not mean they were mild.',
    );
  });

  it('a value this client does not know reads as not established, never as rare or mild', () => {
    expect(frequencyLabel('sometimes')).toBe('Frequency not established');
    expect(severityLabel('trivial')).toBe('Severity not established');
    expect(isGraded('not-established')).toBe(false);
    expect(isGraded('mild')).toBe(true);
  });

  it('the research text prints both states with the explanation, and parses the severityNote', () => {
    const safety = {
      overallRating: 'moderate',
      sideEffects: [
        { effect: 'SJS', frequency: 'very-rare', severity: 'severe', mitigation: null },
        {
          effect: 'Gas',
          frequency: 'unknown',
          severity: 'not-established',
          severityNote: SEVERITY_NOT_ESTABLISHED_NOTE,
          mitigation: null,
        },
      ],
    };
    const text = research.format.text({ detail: { slug: 'x', name: 'X' } as never, safety: safety as never });
    expect(text).toContain('Severe, Very rare (fewer than 1 in 10,000 people)');
    expect(text).toContain('Severity not established, Frequency not established');
    expect(text).toContain(SEVERITY_NOT_ESTABLISHED_NOTE);
    expect(text).not.toMatch(/Mild/);
  });
});
