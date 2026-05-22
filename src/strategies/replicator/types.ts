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
  lmtsApiKey: string;
  polyFunder: string; // Polymarket UI-shown address (Safe or deposit wallet)
  // User-facing: 2 = legacy Safe/proxy (created before CLOB V2),
  //              3 = new deposit wallet (created after CLOB V2).
  // Matches the Python original + what Polymarket's UI tells users.
  // Translated to @polymarket/clob-client's enum (POLY_GNOSIS_SAFE=2, POLY_PROXY=1)
  // in core/polymarket/client.ts.
  polySignatureType: 2 | 3;
  orderSize: number; // contracts per order (same N on YES and NO sides)
  marginBps: number; // bps inside the Poly price (100 = 1%)
  hedgeThreshold: number; // min |net shares| before triggering a hedge
  hedgeIntervalSec: number; // seconds between hedge checks
  dryRun: boolean; // log intents, don't sign or POST
  pairs: MarketPair[];
}
