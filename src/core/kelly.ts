/**
 * kelly-lite — fractional Kelly position sizing for prediction-market contracts.
 *
 * Pure math, no edge claim of its own: you supply your own probability estimate
 * and the current price; this returns how much to risk. The point is discipline
 * — size every bet to your edge with a hard cap, instead of a flat bet size.
 *
 * Binary contract model: a YES (or NO) share costs `price` (0..1) and pays $1 if
 * it resolves your way, $0 otherwise. So you risk `price` per share to win
 * `1 - price`. With your believed win probability `trueProb`, the Kelly-optimal
 * fraction of bankroll to put AT RISK is:
 *
 *     b   = (1 - price) / price          // net odds: win b per 1 risked
 *     f*  = (b·p - (1 - p)) / b          // classic Kelly
 *         = p - (1 - p) / b
 *
 * f* ≤ 0 means no edge (your prob doesn't beat the price) → don't bet. We then
 * apply a `fraction` multiplier (quarter-Kelly by default — full Kelly is too
 * swingy for real use) and clamp the dollar risk to `maxRiskUsd`.
 */

export interface KellyInput {
  /** Your estimated probability the contract resolves in your favour (0..1). */
  trueProb: number;
  /** Current cost per share (0..1). YES price if buying YES, NO price if buying NO. */
  price: number;
  /** Total bankroll to size against, in USD. */
  bankrollUsd: number;
  /** Kelly multiplier. 1 = full Kelly (aggressive), 0.25 = quarter (default, safer). */
  fraction?: number;
  /** Hard cap on dollars at risk for this single bet. */
  maxRiskUsd?: number;
}

export interface KellyResult {
  /** Fraction of bankroll to risk after the multiplier + cap (0..1). */
  fractionOfBankroll: number;
  /** Dollars to put at risk (= shares × price). 0 when there's no edge. */
  riskUsd: number;
  /** Number of contracts to buy (riskUsd / price), floored to the 0.001 grid. */
  shares: number;
  /** Raw full-Kelly fraction before the multiplier/cap — for inspection. */
  rawKelly: number;
  /** Human-readable explanation. */
  reason: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const floor3 = (n: number) => Math.floor(n * 1000) / 1000;

/**
 * Size a single binary-contract bet via fractional Kelly with a risk cap.
 * Returns zero risk (with a reason) whenever the inputs are degenerate or there
 * is no positive edge — callers can treat riskUsd === 0 as "skip".
 */
export function kellySize(input: KellyInput): KellyResult {
  const { trueProb, price, bankrollUsd } = input;
  const fraction = input.fraction ?? 0.25;
  const maxRiskUsd = input.maxRiskUsd ?? Infinity;

  const none = (reason: string): KellyResult => ({
    fractionOfBankroll: 0,
    riskUsd: 0,
    shares: 0,
    rawKelly: 0,
    reason,
  });

  const p = clamp01(trueProb);
  if (!(price > 0 && price < 1)) return none('price must be strictly between 0 and 1');
  if (!(bankrollUsd > 0)) return none('bankroll must be positive');
  if (!(fraction > 0)) return none('fraction must be positive');

  const b = (1 - price) / price; // net odds
  const rawKelly = p - (1 - p) / b; // classic Kelly fraction
  if (rawKelly <= 0) {
    return { ...none('no edge — your probability does not beat the price'), rawKelly };
  }

  const fractionOfBankroll = clamp01(rawKelly * fraction);
  const uncappedRisk = fractionOfBankroll * bankrollUsd;
  const riskUsd = Math.min(uncappedRisk, maxRiskUsd);
  const shares = floor3(riskUsd / price);
  const capped = riskUsd < uncappedRisk;

  return {
    fractionOfBankroll,
    riskUsd,
    shares,
    rawKelly,
    reason: `${(fraction * 100).toFixed(0)}%-Kelly: risk $${riskUsd.toFixed(2)}` +
      ` (${(fractionOfBankroll * 100).toFixed(1)}% of bankroll)${capped ? ` [capped at $${maxRiskUsd}]` : ''}`,
  };
}
