/**
 * Config loader for the replicator strategy.
 *
 * Secrets come from `.env` (process env). Trading params + market pairs
 * come from a YAML file (default `./replicator.config.yaml`).
 *
 * Port of `config.py` from limitless-replicator.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import 'dotenv/config';
import type { MarketPair, ReplicatorSettings } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `${name} not set — check your .env file (see .env.example for the full list).`,
    );
  }
  return val;
}

interface YamlPair {
  polymarket_slug?: string;
  polymarketSlug?: string;
  limitless_slug?: string;
  limitlessSlug?: string;
}

interface YamlConfig {
  poly_funder?: string;
  polyFunder?: string;
  poly_signature_type?: number;
  polySignatureType?: number;
  order_size?: number;
  orderSize?: number;
  margin_bps?: number;
  marginBps?: number;
  hedge_threshold?: number;
  hedgeThreshold?: number;
  hedge_interval?: number;
  hedgeIntervalSec?: number;
  hedge_settle_ms?: number;
  hedgeSettleMs?: number;
  min_requote_ms?: number;
  minRequoteMs?: number;
  max_loss_usd?: number;
  maxLossUsd?: number;
  flatten_on_stop?: boolean;
  flattenOnStop?: boolean;
  dry_run?: boolean;
  dryRun?: boolean;
  market_pairs?: YamlPair[];
  marketPairs?: YamlPair[];
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

export function loadSettings(): ReplicatorSettings {
  const privateKey = requireEnv('PRIVATE_KEY');

  // Limitless auth. Prefer scoped HMAC token (LMTS_TOKEN_ID + LMTS_TOKEN_SECRET);
  // fall back to the deprecated X-API-Key (LIMITLESS_API_KEY) for legacy users.
  const tokenId = process.env.LMTS_TOKEN_ID;
  const tokenSecret = process.env.LMTS_TOKEN_SECRET;
  const legacyApiKey = process.env.LIMITLESS_API_KEY;
  const hmacCredentials =
    tokenId && tokenSecret ? { tokenId, secret: tokenSecret } : undefined;
  if (!hmacCredentials && !legacyApiKey) {
    throw new Error(
      'No Limitless auth configured. Set LMTS_TOKEN_ID + LMTS_TOKEN_SECRET ' +
        '(scoped HMAC token — preferred) or LIMITLESS_API_KEY (deprecated). ' +
        'See docs.limitless.exchange/developers/authentication.',
    );
  }

  const configPath = process.env.REPLICATOR_CONFIG_PATH || './replicator.config.yaml';

  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `replicator config file not found at ${resolved}. ` +
        `Copy src/strategies/replicator/config.example.yaml and edit it, ` +
        `or set REPLICATOR_CONFIG_PATH.`,
    );
  }

  const raw = (yaml.load(fs.readFileSync(resolved, 'utf-8')) ?? {}) as YamlConfig;

  const pairsRaw = raw.market_pairs ?? raw.marketPairs ?? [];
  if (pairsRaw.length === 0) {
    throw new Error(`replicator config has no market_pairs`);
  }
  const pairs: MarketPair[] = pairsRaw.map((p) => {
    const poly = p.polymarket_slug ?? p.polymarketSlug;
    const lmts = p.limitless_slug ?? p.limitlessSlug;
    if (!poly || !lmts) {
      throw new Error(
        `replicator config: each market_pair needs polymarket_slug + limitless_slug`,
      );
    }
    return { polymarketSlug: poly, limitlessSlug: lmts };
  });

  // Default 3 (POLY_1271 deposit wallet) — what new Polymarket API users get.
  // Existing Gnosis Safe users set 2.
  const sigTypeRaw = raw.poly_signature_type ?? raw.polySignatureType ?? 3;
  if (sigTypeRaw !== 2 && sigTypeRaw !== 3) {
    throw new Error(
      `poly_signature_type must be 2 (existing Gnosis Safe) or 3 (deposit wallet / POLY_1271), got ${sigTypeRaw}`,
    );
  }

  // Env DRY_RUN overrides YAML; sensible default = false.
  const dryRun = isTruthyEnv(process.env.DRY_RUN) || (raw.dry_run ?? raw.dryRun ?? false);

  // SIMULATE_FILL=YES:5 (DRY_RUN-only) — inject a synthetic fill to exercise
  // the hedge pipeline end-to-end without a live taker.
  let simulateFill: ReplicatorSettings['simulateFill'];
  const simRaw = process.env.SIMULATE_FILL;
  if (simRaw) {
    const [sideStr, sharesStr] = simRaw.split(':');
    const side = sideStr?.toUpperCase() === 'NO' ? 'NO' : 'YES';
    const shares = Number(sharesStr ?? 5);
    if (shares > 0) simulateFill = { side, shares };
  }

  return {
    privateKey,
    hmacCredentials,
    lmtsApiKey: legacyApiKey,
    polyFunder: raw.poly_funder ?? raw.polyFunder ?? '',
    polySignatureType: sigTypeRaw as 2 | 3,
    orderSize: Number(raw.order_size ?? raw.orderSize ?? 100),
    marginBps: Number(raw.margin_bps ?? raw.marginBps ?? 100),
    hedgeThreshold: Number(raw.hedge_threshold ?? raw.hedgeThreshold ?? 2),
    hedgeIntervalSec: Number(raw.hedge_interval ?? raw.hedgeIntervalSec ?? 5),
    // Default 12s: ~2× the observed Polymarket data-api settle lag. Prevents the
    // hedger from re-hedging a pair on a stale (pre-hedge) position read.
    hedgeSettleMs: Number(raw.hedge_settle_ms ?? raw.hedgeSettleMs ?? 12000),
    // Default 2s/pair: keeps a 3-pair run well under the Limitless API rate
    // limit while staying responsive. Lower it only if a single pair needs
    // tighter tracking and you've confirmed you're not getting 429s.
    minRequoteMs: Number(raw.min_requote_ms ?? raw.minRequoteMs ?? 2000),
    maxLossUsd: Number(
      process.env.REPLICATOR_MAX_LOSS_USD ?? raw.max_loss_usd ?? raw.maxLossUsd ?? 10,
    ),
    // Default ON: a stop (Ctrl-C or breaker) sells inventory to flat on both
    // venues, not just cancels resting orders. Set flatten_on_stop: false to
    // leave inventory in place (only orders are cancelled) — rarely wanted,
    // since it leaves unhedged directional risk.
    flattenOnStop: raw.flatten_on_stop ?? raw.flattenOnStop ?? true,
    dryRun,
    simulateFill,
    pairs,
  };
}
