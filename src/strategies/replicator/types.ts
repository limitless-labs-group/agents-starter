/**
 * Replicator strategy types.
 *
 * Port of `config.py` from limitless-labs-group/limitless-replicator.
 * Strategy invariants (see README):
 *   1. Both Limitless quotes are BUY (YES at poly_bid - margin, NO at (1 - poly_ask) - margin).
 *   2. Cancel-all + replace every tick (no diff optimizer).
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
  maxLossUsd: number; // circuit breaker: halt + cancel-all if equity drawdown ≥ this
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
