/**
 * find-pairs polarity guard — catches negation/direction-flipped pairs that
 * token similarity can't see (negation words are stopwords).
 */

import { describe, expect, it } from 'vitest';
import { polarityRisk } from '../../src/strategies/cross-market-mm/find-pairs.js';

describe('polarityRisk', () => {
  it('flags the real OpenAI negation case', () => {
    const r = polarityRisk(
      'OpenAI IPO by December 31, 2026?',
      'Will OpenAI not IPO by December 31, 2026?',
    );
    expect(r).toMatch(/negation/);
  });

  it('passes a genuinely-aligned pair', () => {
    expect(
      polarityRisk('Bitcoin above $150k by Dec 31?', 'Will Bitcoin be above $150,000 by Dec 31?'),
    ).toBeNull();
  });

  it('flags an above/below direction flip', () => {
    expect(polarityRisk('BTC above $150k on Friday', 'Will BTC be below $150k on Friday')).toMatch(
      /direction/,
    );
  });

  it('does not flag when both sides share the same negation', () => {
    expect(polarityRisk('Will X not happen?', 'Y will not occur')).toBeNull();
  });

  it('does not false-positive on substrings (e.g. "notable")', () => {
    expect(polarityRisk('A notable event happens', 'A notable event occurs')).toBeNull();
  });
});
