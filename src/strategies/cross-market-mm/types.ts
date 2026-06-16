/**
 * Cross-market MM strategy types.
 *
 * Strategy invariants (see README):
 *   1. Both Limitless quotes are BUY (YES at poly_bid - margin, NO at (1 - poly_ask) - margin).
 *   2. Diff requoter: unchanged whole-cent quotes stay resting (queue position
 *      preserved); any uncertainty degrades to cancel-all + replace.
 *   3. Hedge always BUYs on Polymarket (FAK).
 *   4. YES-frame is canonical (poly_ws inverts NO updates).
 */

export interface MarketPair {
  polymarketSlug: string;
  limitlessSlug: string;
  // Filled at runtime by clients during boot — don't set in YAML.
  yesToken?: string; // Limitless YES token id
  noToken?: string; // Limitless NO token id
  exchangeAddress?: string; // Limitless CTF exchange contract (default or neg-risk)
  polyYesAssetId?: string; // Polymarket YES clob token id
  polyNoAssetId?: string; // Polymarket NO clob token id
}

export interface ReplicatorSettings {
  privateKey: string; // 0x... — must be funded on Base AND Polygon
  // Limitless auth. Prefer scoped HMAC token (tokenId + secret); plain API
  // keys are deprecated. Exactly one of these is populated by config loading.
  hmacCredentials?: { tokenId: string; secret: string };
  lmtsApiKey?: string; // legacy X-API-Key fallback
  polyFunder: string; // Polymarket UI-shown address (Safe or deposit wallet)
  // User-facing: 2 = existing Gnosis Safe, 3 = deposit wallet (POLY_1271,
  // the default for new API users). Maps 1:1 onto clob-client-v2's
  // SignatureTypeV2 in core/polymarket/client.ts.
  polySignatureType: 2 | 3;
  orderSize: number; // contracts per order (same N on YES and NO sides)
  marginBps: number; // bps inside the Poly price (100 = 1%)
  hedgeThreshold: number; // min |net shares| before triggering a hedge
  hedgeIntervalSec: number; // seconds between hedge checks
  // After a hedge fires on a pair, don't hedge that pair again for this long.
  // The Polymarket data-api position read lags a fill by several seconds, so
  // without this the hedger re-reads a stale (pre-hedge) position and fires the
  // SAME hedge again, over-trading. Must exceed the data-api settle lag.
  hedgeSettleMs: number;
  // Floor on re-quote frequency per pair (ms). The quote cycle still runs every
  // tick, but coalesces bursts to at most one cycle per this interval, always
  // quoting the freshest book. Prevents the Limitless API Cloudflare rate-limit
  // (429/1015) that an unthrottled multi-pair run trips on sustained operation.
  minRequoteMs: number;
  // How often (ms) the diff requoter confirms both resting orders are still
  // live while it skips unchanged quotes. A fill consumes an order silently;
  // this bounds how long a consumed side can sit unquoted. Keep it in the same
  // range as the hedger interval — checking much faster buys nothing.
  livenessCheckMs: number;
  maxLossUsd: number; // circuit breaker: halt + cancel-all if equity drawdown ≥ this
  // Inventory guard: when |net shares| on a pair reaches this, pull quotes
  // (write pull.flag) so the quoter stops adding inventory while the hedger
  // flattens. The lighter, earlier-firing sibling of the loss breaker. 0 = off.
  maxNetShares: number;
  // Inventory guard, second trigger: after this many CONSECUTIVE failed hedges
  // on a pair (broken Poly route), pull quotes. 0 = off.
  maxHedgeFailures: number;
  flattenOnStop: boolean; // on Ctrl-C/breaker, also SELL inventory to flat (both venues), not just cancel orders
  dryRun: boolean; // log intents, don't sign or POST
  /**
   * DRY_RUN-only: inject a synthetic Limitless fill on the first pair so the
   * real hedger pipeline (decide → hedge → record) runs end-to-end without a
   * live taker. Set via SIMULATE_FILL=YES:5 (side:shares). Ignored when live.
   */
  simulateFill?: { side: 'YES' | 'NO'; shares: number };
  pairs: MarketPair[];
}
