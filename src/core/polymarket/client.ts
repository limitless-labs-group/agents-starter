/**
 * Polymarket adapter: Gamma + Data API + CLOB hedge orders.
 *
 * Port of `clients/polymarket.py` from limitless-replicator.
 *
 * Responsibilities:
 *   1. Resolve a polymarket_slug to its YES/NO clob asset ids (Gamma API).
 *   2. Read live positions across our configured pairs (Data API).
 *   3. Fire FAK BUY hedge orders on the CLOB to flatten exposure.
 *
 * Reads (Gamma + Data) are unauthenticated REST via native `fetch`. The
 * hedge path uses `@polymarket/clob-client`, which handles the EIP-712 +
 * L2 auth flow for both signatureType 2 (legacy proxy/Safe) and 3 (new
 * deposit wallet).
 *
 * Signing uses viem (already an agents-starter dep). The Polymarket CLOB
 * client's `ClobSigner` accepts a viem `WalletClient` directly — cleaner
 * than the ethers v6 path (whose `signTypedData` doesn't match the
 * ethers v5 `_signTypedData` shape the CLOB client's `EthersSigner`
 * branch expects).
 */

import { pino } from 'pino';
import {
  ClobClient,
  Chain,
  Side,
  OrderType,
  SignatureType,
} from '@polymarket/clob-client';
import { createWalletClient, http as viemHttp, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import type { MarketPair } from '../../strategies/replicator/types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'polymarket-client',
});

const POLYMARKET_CLOB_URL = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';
const POLYMARKET_GAMMA_URL =
  process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';
const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL || 'https://data-api.polymarket.com';

/**
 * Map user-facing Python-style signature_type (2 | 3) to
 * `@polymarket/clob-client`'s enum.
 *   user 2 → POLY_GNOSIS_SAFE (legacy Safe / proxy)
 *   user 3 → POLY_PROXY       (new deposit wallet)
 *
 * The Python `py-clob-client-v2` used 2/3 directly; the TS client uses
 * 0/1/2. We honor Python conventions because they match what Polymarket's
 * UI tells users.
 */
function translateSignatureType(userValue: 2 | 3): SignatureType {
  return userValue === 2 ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.POLY_PROXY;
}

export interface PolymarketAdapterConfig {
  privateKey: string;
  funder: string;
  signatureType: 2 | 3;
  dryRun: boolean;
}

export class PolymarketAdapter {
  private readonly funder: string;
  private readonly dryRun: boolean;
  private readonly cfg: PolymarketAdapterConfig;
  /** Live CLOB client — only constructed after authProbe() in non-dry mode. */
  private clob: ClobClient | null = null;

  constructor(config: PolymarketAdapterConfig) {
    this.funder = config.funder;
    this.dryRun = config.dryRun;
    this.cfg = config;
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
    const wallet: WalletClient = createWalletClient({
      account,
      chain: polygon,
      transport: viemHttp(),
    });
    const sigType = translateSignatureType(this.cfg.signatureType);

    // 1. Bootstrap client with no creds — only used to derive them.
    const bootstrap = new ClobClient(
      POLYMARKET_CLOB_URL,
      Chain.POLYGON,
      wallet,
      undefined,
      sigType,
      this.cfg.funder,
    );

    let creds;
    try {
      creds = await bootstrap.createOrDeriveApiKey();
    } catch (err) {
      throw new Error(
        `Polymarket auth probe failed: ${(err as Error).message}. ` +
          `Check PRIVATE_KEY, poly_funder, and poly_signature_type ` +
          `(2 = legacy Safe / proxy, 3 = new deposit wallet).`,
      );
    }

    // 2. Real client with creds wired in — used for all subsequent calls.
    this.clob = new ClobClient(
      POLYMARKET_CLOB_URL,
      Chain.POLYGON,
      wallet,
      creds,
      sigType,
      this.cfg.funder,
    );

    logger.info({ funder: this.funder }, 'Polymarket auth OK');
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
      const resp = await this.clob.createAndPostMarketOrder(
        { tokenID: assetId, side: Side.BUY, amount: buyUsdc },
        undefined,
        OrderType.FAK,
      );
      const success =
        typeof resp === 'object' && resp !== null && (resp as { success?: boolean }).success === true;
      if (!success) {
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
}
