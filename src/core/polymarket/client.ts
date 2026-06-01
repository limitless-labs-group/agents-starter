/**
 * Polymarket adapter: Gamma + Data API + CLOB hedge orders.
 *
 * Responsibilities:
 *   1. Resolve a polymarket_slug to its YES/NO clob asset ids (Gamma API).
 *   2. Read live positions across our configured pairs (Data API).
 *   3. Fire FAK BUY hedge orders on the CLOB to flatten exposure.
 *
 * Reads (Gamma + Data) are unauthenticated REST via native `fetch`. The
 * hedge path uses `@polymarket/clob-client-v2`. v2 is required, not optional:
 * Polymarket migrated collateral from USDC.e to pUSD on a new V2 exchange,
 * and only v2 trades pUSD. The old v1 client (USDC.e / old exchange) would
 * fail "insufficient balance" against a pUSD-funded account.
 *
 * Signature types (SignatureTypeV2): 2 = GNOSIS_SAFE (existing Safe users),
 * 3 = POLY_1271 (deposit wallets — the default for new API users). The
 * funder is the Safe address (sig 2) or the deposit-wallet address (sig 3).
 *
 * Signing uses viem (already an agents-starter dep). v2's `ClobSigner`
 * accepts a viem `WalletClient` directly.
 */

import { pino } from 'pino';
import {
  ClobClient,
  Chain,
  Side,
  OrderType,
  SignatureTypeV2,
  AssetType,
  type ApiKeyCreds,
} from '@polymarket/clob-client-v2';
import { createWalletClient, http as viemHttp, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import type { MarketPair } from '../../strategies/cross-market-mm/types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'polymarket-client',
});

const POLYMARKET_CLOB_URL = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
const POLYMARKET_GAMMA_URL =
  process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL || 'https://data-api.polymarket.com';

/**
 * Map user-facing signature_type (2 | 3) to v2's `SignatureTypeV2`.
 *   user 2 → GNOSIS_SAFE (existing Gnosis Safe users)
 *   user 3 → POLY_1271   (deposit wallets — default for new API users)
 *
 * v2's enum values line up 1:1 with the numbers Polymarket's docs/UI use,
 * so this is effectively an identity map kept explicit for type-safety.
 */
function translateSignatureType(userValue: 2 | 3): SignatureTypeV2 {
  return userValue === 2 ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.POLY_1271;
}

export interface PolymarketAdapterConfig {
  privateKey: string;
  funder: string;
  signatureType: 2 | 3;
  dryRun: boolean;
  /**
   * Optional Polymarket builder code for order attribution (Builder Program).
   * Not required to trade. Falls back to POLY_BUILDER_CODE env if unset.
   */
  builderCode?: string;
}

export class PolymarketAdapter {
  private readonly funder: string;
  private readonly dryRun: boolean;
  private readonly cfg: PolymarketAdapterConfig;
  private readonly builderCode?: string;
  /** Live CLOB client — only constructed after authProbe() in non-dry mode. */
  private clob: ClobClient | null = null;

  constructor(config: PolymarketAdapterConfig) {
    this.funder = config.funder;
    this.dryRun = config.dryRun;
    this.cfg = config;
    this.builderCode = config.builderCode || process.env.POLY_BUILDER_CODE || undefined;
    if (config.dryRun) {
      logger.warn('PolymarketAdapter: DRY_RUN — CLOB client not initialized');
    }
  }

  /**
   * Boot-time auth probe — mirrors the Limitless probe.
   *
   * The CLOB client needs creds (API key + secret + passphrase) for L2 auth.
   * We derive them via a temporary unauth client, then construct the real
   * client with creds wired in. Failure here usually means the wrong
   * signatureType for the wallet (POLY_GNOSIS_SAFE vs POLY_PROXY).
   *
   * In DRY_RUN we skip the derivation — no signed orders are sent so we
   * never need creds.
   */
  async authProbe(): Promise<void> {
    if (this.dryRun) {
      logger.info('[DRY_RUN] skipping Polymarket auth probe');
      return;
    }

    const pk = (this.cfg.privateKey.startsWith('0x')
      ? this.cfg.privateKey
      : `0x${this.cfg.privateKey}`) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const signer: WalletClient = createWalletClient({
      account,
      chain: polygon,
      transport: viemHttp(),
    });
    const signatureType = translateSignatureType(this.cfg.signatureType);

    // 1. Bootstrap client with no creds — only used to derive (L1 EIP-712) them.
    const bootstrap = new ClobClient({
      host: POLYMARKET_CLOB_URL,
      chain: Chain.POLYGON,
      signer,
    });

    let creds: ApiKeyCreds;
    try {
      creds = await bootstrap.createOrDeriveApiKey();
    } catch (err) {
      throw new Error(
        `Polymarket auth probe failed: ${(err as Error).message}. ` +
          `Check PRIVATE_KEY, poly_funder, and poly_signature_type ` +
          `(2 = existing Gnosis Safe, 3 = deposit wallet / POLY_1271).`,
      );
    }

    // 2. Real client with creds + sig type + funder — used for all orders.
    this.clob = new ClobClient({
      host: POLYMARKET_CLOB_URL,
      chain: Chain.POLYGON,
      signer,
      creds,
      signatureType,
      funderAddress: this.cfg.funder,
    });

    logger.info({ funder: this.funder, signatureType }, 'Polymarket auth OK');
  }

  /**
   * Free pUSD collateral on Polymarket (the V2 collateral token), in dollars.
   * Used by the risk monitor. Returns 0 in DRY_RUN (no live client).
   */
  async getCollateralBalance(): Promise<number> {
    if (this.dryRun || !this.clob) return 0;
    const bal = await this.clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return Number(bal.balance) / 1e6;
  }

  /** Populate pair.polyYesAssetId / polyNoAssetId from a Gamma lookup. */
  async resolveAssetIds(pair: MarketPair): Promise<void> {
    for (const path of [
      `/markets/slug/${pair.polymarketSlug}`,
      `/events/slug/${pair.polymarketSlug}`,
    ]) {
      let data: unknown;
      try {
        const r = await fetch(`${POLYMARKET_GAMMA_URL}${path}`);
        if (!r.ok) continue;
        data = await r.json();
      } catch (err) {
        logger.debug({ path, err: (err as Error).message }, 'gamma fetch failed');
        continue;
      }

      const sources: Array<{ clobTokenIds?: string | string[] }> = [
        data as { clobTokenIds?: string | string[] },
        ...((data as { markets?: Array<{ clobTokenIds?: string | string[] }> }).markets ?? []),
      ];

      for (const src of sources) {
        const raw = src.clobTokenIds;
        if (!raw) continue;
        const ids = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : raw;
        if (ids.length >= 2) {
          pair.polyYesAssetId = ids[0];
          pair.polyNoAssetId = ids[1];
          logger.info(
            {
              slug: pair.polymarketSlug,
              yes: ids[0].slice(0, 8) + '…',
              no: ids[1].slice(0, 8) + '…',
            },
            'Polymarket assets resolved',
          );
          return;
        }
      }
    }
    throw new Error(`could not resolve Polymarket asset ids for ${pair.polymarketSlug}`);
  }

  /**
   * Returns `{ polymarketSlug: { yes, no } }` of held positions across the
   * given pairs. Pairs without a position are absent from the map.
   */
  async getPositions(pairs: MarketPair[]): Promise<Map<string, { yes: number; no: number }>> {
    const out = new Map<string, { yes: number; no: number }>();
    let raw: Array<{ asset?: string; size?: number }> = [];
    try {
      const r = await fetch(
        `${POLYMARKET_DATA_URL}/positions?user=${this.funder}&sizeThreshold=0.0001`,
      );
      if (!r.ok) {
        logger.warn({ status: r.status }, 'poly getPositions non-200');
        return out;
      }
      raw = (await r.json()) as Array<{ asset?: string; size?: number }>;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'poly getPositions failed');
      return out;
    }

    const lookup = new Map<string, { slug: string; isYes: boolean }>();
    for (const p of pairs) {
      if (p.polyYesAssetId) lookup.set(p.polyYesAssetId, { slug: p.polymarketSlug, isYes: true });
      if (p.polyNoAssetId) lookup.set(p.polyNoAssetId, { slug: p.polymarketSlug, isYes: false });
    }

    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
      const assetId = String(item.asset ?? '');
      const size = Number(item.size ?? 0);
      if (!Number.isFinite(size)) continue;
      const entry = lookup.get(assetId);
      if (!entry) continue;
      const cur = out.get(entry.slug) ?? { yes: 0, no: 0 };
      if (entry.isYes) cur.yes += size;
      else cur.no += size;
      out.set(entry.slug, cur);
    }
    return out;
  }

  /**
   * Fire a FAK (IOC) market BUY for `buyUsdc` worth of `assetId`.
   * Returns true if Polymarket accepted the order.
   */
  async hedgeBuy(assetId: string, buyUsdc: number): Promise<boolean> {
    if (this.dryRun) {
      logger.info(
        { assetId: assetId.slice(0, 8) + '…', buyUsdc: buyUsdc.toFixed(2) },
        '[DRY_RUN] would hedgeBuy',
      );
      return true;
    }
    if (!this.clob) {
      throw new Error(
        'PolymarketAdapter: hedgeBuy called before authProbe() — wire your bootstrap correctly',
      );
    }

    try {
      // v2 needs the market's tick size + neg-risk flag to round/route the order.
      const [tickSize, negRisk] = await Promise.all([
        this.clob.getTickSize(assetId),
        this.clob.getNegRisk(assetId),
      ]);
      const resp = await this.clob.createAndPostMarketOrder(
        {
          tokenID: assetId,
          side: Side.BUY,
          amount: buyUsdc, // BUY: amount is $$$ to spend
          orderType: OrderType.FAK,
          ...(this.builderCode ? { builderCode: this.builderCode } : {}),
        },
        { tickSize, negRisk },
        OrderType.FAK,
      );
      const success =
        typeof resp === 'object' && resp !== null && (resp as { success?: boolean }).success === true;
      if (success) {
        logger.info(
          { assetId: assetId.slice(0, 8) + '…', buyUsdc: buyUsdc.toFixed(2) },
          'hedge filled',
        );
      } else {
        logger.info({ resp }, 'hedge rejected');
      }
      return success;
    } catch (err) {
      logger.warn(
        { assetId: assetId.slice(0, 8) + '…', err: (err as Error).message },
        'hedgeBuy failed',
      );
      return false;
    }
  }

  /**
   * SELL `shares` of an asset on Polymarket (market FAK) — closes hedge
   * inventory back to flat. For a market SELL, `amount` is the number of
   * SHARES (not USDC, unlike hedgeBuy). The exit-side mirror of hedgeBuy.
   */
  async sellShares(assetId: string, shares: number): Promise<boolean> {
    if (this.dryRun) {
      logger.info(
        { assetId: assetId.slice(0, 8) + '…', shares: shares.toFixed(2) },
        '[DRY_RUN] would SELL to close',
      );
      return true;
    }
    if (!this.clob) {
      throw new Error('PolymarketAdapter: sellShares called before authProbe()');
    }
    try {
      const [tickSize, negRisk] = await Promise.all([
        this.clob.getTickSize(assetId),
        this.clob.getNegRisk(assetId),
      ]);
      const resp = await this.clob.createAndPostMarketOrder(
        {
          tokenID: assetId,
          side: Side.SELL,
          amount: shares, // SELL: amount is SHARES
          orderType: OrderType.FAK,
          ...(this.builderCode ? { builderCode: this.builderCode } : {}),
        },
        { tickSize, negRisk },
        OrderType.FAK,
      );
      const success =
        typeof resp === 'object' && resp !== null && (resp as { success?: boolean }).success === true;
      if (success) {
        logger.info({ assetId: assetId.slice(0, 8) + '…', shares: shares.toFixed(2) }, 'poly close sell filled');
      } else {
        logger.info({ resp }, 'poly close sell rejected');
      }
      return success;
    } catch (err) {
      logger.warn(
        { assetId: assetId.slice(0, 8) + '…', err: (err as Error).message },
        'poly sellShares failed',
      );
      return false;
    }
  }
}
