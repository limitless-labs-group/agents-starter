/**
 * Hedger loop.
 *
 * Every `hedgeIntervalSec` seconds:
 *   1. Poll positions on Limitless + Polymarket (REST).
 *   2. For each pair, compute net exposure:
 *        net = (lmts_yes - lmts_no) + (poly_yes - poly_no)
 *   3. If |net| >= hedge_threshold, fire a FAK BUY on Polymarket on the
 *      opposite side to flatten.
 *
 * Strategy invariant: hedge always BUYs on Polymarket. Too much YES → buy NO.
 * Too much NO → buy YES. Never sell on Polymarket.
 *
 * Port of `hedger.py` from limitless-replicator.
 */

import { pino } from 'pino';
import type { Client } from '@limitless-exchange/sdk';
import type { PolymarketAdapter } from '../../core/polymarket/client.js';
import { QuoteFeed, quoteMid } from './quote-feed.js';
import type { Recorder } from './recorder.js';
import { RiskMonitor, readBaseUsdc, markPairValue, totalEquity } from './risk.js';
import type { MarketPair, ReplicatorSettings } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'hedger' });

/**
 * Pure direction + USDC-notional math — exposed for testing.
 *
 * net > 0 → too much YES → buy NO on Poly. Price for the NO side = 1 - poly_bid.
 * net < 0 → too much NO  → buy YES on Poly. Price for the YES side = poly_ask.
 */
export interface HedgeDecision {
  shouldHedge: boolean;
  buyYes: boolean; // true → buy YES asset; false → buy NO asset
  amountShares: number;
  pricePerShare: number;
  notionalUsdc: number;
  reason?: string;
}

export function decideHedge(args: {
  netShares: number;
  hedgeThreshold: number;
  polyBid: number | null;
  polyAsk: number | null;
}): HedgeDecision {
  const { netShares, hedgeThreshold, polyBid, polyAsk } = args;

  if (Math.abs(netShares) < hedgeThreshold) {
    return {
      shouldHedge: false,
      buyYes: false,
      amountShares: 0,
      pricePerShare: 0,
      notionalUsdc: 0,
      reason: 'under threshold',
    };
  }

  const buyYes = netShares < 0;
  // Buying YES → cross the YES ask. Buying NO → cross "NO ask" = 1 - YES bid.
  const price = buyYes ? polyAsk : polyBid != null ? 1 - polyBid : null;
  if (price == null || !(price > 0 && price < 1)) {
    return {
      shouldHedge: false,
      buyYes,
      amountShares: 0,
      pricePerShare: 0,
      notionalUsdc: 0,
      reason: 'no usable price',
    };
  }

  const amountShares = Math.abs(netShares);
  const notional = amountShares * price;

  if (notional < 1.0) {
    // Polymarket rejects sub-$1 notional. Don't waste a request.
    return {
      shouldHedge: false,
      buyYes,
      amountShares,
      pricePerShare: price,
      notionalUsdc: notional,
      reason: 'notional too small',
    };
  }

  return {
    shouldHedge: true,
    buyYes,
    amountShares,
    pricePerShare: price,
    notionalUsdc: notional,
  };
}

interface LimitlessPositions {
  [slug: string]: { yes: number; no: number };
}

interface PolyPositionsMap {
  get(slug: string): { yes: number; no: number } | undefined;
}

/**
 * One hedge tick. Exposed for testing — `runHedger` is the long-running
 * task that calls this on a schedule.
 */
export async function hedgeOnce(
  pairs: MarketPair[],
  feed: QuoteFeed,
  lmtsPositions: LimitlessPositions,
  polyPositions: PolyPositionsMap,
  poly: PolymarketAdapter,
  settings: ReplicatorSettings,
  recorder?: Recorder,
  // Per-pair timestamp of the last fired hedge (epoch ms). Owned by the caller
  // so it persists across ticks; defaults to an ephemeral map (tests/one-offs).
  // Gates re-hedging within settings.hedgeSettleMs so a lagged Poly position
  // read can't make us fire the same hedge twice (stale-read stacking).
  lastHedgeAt: Map<string, number> = new Map(),
): Promise<void> {
  for (const pair of pairs) {
    const lm = lmtsPositions[pair.limitlessSlug] ?? { yes: 0, no: 0 };
    const pm = polyPositions.get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
    const net = lm.yes - lm.no + (pm.yes - pm.no);

    // Heartbeat + data point every tick, hedge or not — this is the signal
    // for "is the strategy staying flat / making money?".
    logger.info(
      {
        slug: pair.limitlessSlug,
        net: net.toFixed(2),
        lmts: `${lm.yes.toFixed(1)}/${lm.no.toFixed(1)}`,
        poly: `${pm.yes.toFixed(1)}/${pm.no.toFixed(1)}`,
      },
      'status',
    );
    recorder?.record({
      kind: 'snapshot',
      pair: pair.polymarketSlug,
      net,
      lmtsYes: lm.yes,
      lmtsNo: lm.no,
      polyYes: pm.yes,
      polyNo: pm.no,
    });

    const quote = feed.getQuote(pair.polymarketSlug);
    const decision = decideHedge({
      netShares: net,
      hedgeThreshold: settings.hedgeThreshold,
      polyBid: quote?.bid ?? null,
      polyAsk: quote?.ask ?? null,
    });

    if (!decision.shouldHedge) continue;

    // Settle gate: if we hedged this pair within hedgeSettleMs, the Poly
    // position read above may not yet reflect that hedge — re-hedging now would
    // stack a duplicate. Wait for the read to settle before acting again.
    const since = Date.now() - (lastHedgeAt.get(pair.polymarketSlug) ?? 0);
    if (since < settings.hedgeSettleMs) {
      logger.info(
        { slug: pair.polymarketSlug, net: net.toFixed(2), waitMs: settings.hedgeSettleMs - since },
        'hedge held: awaiting prior-hedge settle',
      );
      continue;
    }

    const assetId = decision.buyYes ? pair.polyYesAssetId : pair.polyNoAssetId;
    if (!assetId) {
      logger.warn({ slug: pair.polymarketSlug }, 'hedge skipped: asset id missing');
      continue;
    }

    logger.info(
      {
        slug: pair.polymarketSlug,
        net: net.toFixed(2),
        buy: decision.buyYes ? 'YES' : 'NO',
        shares: decision.amountShares.toFixed(2),
        price: decision.pricePerShare.toFixed(4),
        usdc: decision.notionalUsdc.toFixed(2),
      },
      'HEDGE',
    );
    const ok = await poly.hedgeBuy(assetId, decision.notionalUsdc);
    // Start the settle window from the fire so the next tick can't re-stack
    // before the data-api reflects this hedge.
    lastHedgeAt.set(pair.polymarketSlug, Date.now());
    recorder?.record({
      kind: 'hedge',
      pair: pair.polymarketSlug,
      buy: decision.buyYes ? 'YES' : 'NO',
      shares: decision.amountShares,
      price: decision.pricePerShare,
      usdc: decision.notionalUsdc,
      success: ok,
    });
  }
}

/** Limitless positions reader — calls the SDK's PortfolioFetcher.
 *  Throws on auth failure; caller catches and falls through with empty positions. */
async function readLimitlessPositions(sdk: Client): Promise<LimitlessPositions> {
  // The SDK's portfolio endpoint returns per-slug yes/no balances scaled to
  // 6-decimal units. We sum AMM + CLOB buckets the same way the Python
  // version does.
  // Note: type assertion here because the SDK's PortfolioPositionsResponse
  // shape mirrors the API which evolves; we read defensively.
  const raw = (await sdk.portfolio.getPositions()) as unknown as {
    amm?: Array<{
      market?: { slug?: string; token?: { decimals?: number }; collateralToken?: { decimals?: number } };
      tokensBalance?: { yes?: number | string; no?: number | string };
    }>;
    clob?: Array<{
      market?: { slug?: string; token?: { decimals?: number }; collateralToken?: { decimals?: number } };
      tokensBalance?: { yes?: number | string; no?: number | string };
    }>;
  };

  const out: LimitlessPositions = {};
  for (const bucket of ['amm', 'clob'] as const) {
    for (const pos of raw[bucket] ?? []) {
      const slug = pos.market?.slug;
      if (!slug) continue;
      const decimals = pos.market?.token?.decimals ?? pos.market?.collateralToken?.decimals ?? 6;
      const scale = 10 ** decimals;
      const yes = Number(pos.tokensBalance?.yes ?? 0) / scale;
      const no = Number(pos.tokensBalance?.no ?? 0) / scale;
      out[slug] = { yes, no };
    }
  }
  return out;
}

export interface HedgerHooks {
  recorder?: Recorder;
  risk?: RiskMonitor;
  walletAddress?: string; // Base trading wallet, for the free-USDC read
  onKill?: () => void; // called once when the circuit breaker trips
}

/**
 * Run forever (until signal aborts). Polls positions every
 * `settings.hedgeIntervalSec` seconds, hedges threshold-crossing exposure,
 * and (live only) marks equity to trip the loss circuit-breaker.
 */
export async function runHedger(
  pairs: MarketPair[],
  feed: QuoteFeed,
  sdk: Client,
  poly: PolymarketAdapter,
  settings: ReplicatorSettings,
  signal: AbortSignal,
  hooks: HedgerHooks = {},
): Promise<void> {
  const { recorder, risk, walletAddress, onKill } = hooks;
  logger.info({ intervalSec: settings.hedgeIntervalSec }, 'hedger started');

  // DRY_RUN fill simulation state. Walks the real pipeline through:
  //   flat → (tick 2) inject Limitless fill → hedger fires hedge → (tick 3+)
  //   inject the offsetting Poly position → flat (hedged). No real money.
  const sim = settings.dryRun ? settings.simulateFill : undefined;
  if (sim) logger.warn({ sim }, 'SIMULATE_FILL active — injecting a synthetic fill into the pipeline');
  let simTick = 0;
  let simHedged = false;

  // Persistent across ticks: last hedge time per pair, for the settle gate that
  // prevents stale-read hedge stacking.
  const lastHedgeAt = new Map<string, number>();

  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, settings.hedgeIntervalSec * 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) break;

    try {
      // In DRY_RUN no orders are signed → Limitless positions can't accumulate.
      // Skip the authed portfolio read so a missing/invalid API key doesn't
      // spam the log every tick.
      const lmts: LimitlessPositions = settings.dryRun
        ? {}
        : await readLimitlessPositions(sdk).catch((err) => {
            logger.warn(
              { err: (err as Error).message },
              'limitless portfolio read failed — treating as empty for this tick',
            );
            return {} as LimitlessPositions;
          });
      const pm = await poly.getPositions(pairs);

      // -- SIMULATE_FILL (DRY_RUN): inject a synthetic fill on the first pair --
      if (sim && pairs.length > 0) {
        simTick++;
        const pair = pairs[0];
        if (simTick >= 2) {
          // The fill: we now hold `shares` of `side` on Limitless.
          const lm = lmts[pair.limitlessSlug] ?? { yes: 0, no: 0 };
          if (sim.side === 'YES') lm.yes += sim.shares;
          else lm.no += sim.shares;
          lmts[pair.limitlessSlug] = lm;
          // Once the hedge has fired, reflect the offsetting Poly position so
          // the book returns to flat (delta-neutral) on subsequent ticks.
          if (simHedged) {
            const pmPos = pm.get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
            if (sim.side === 'YES') pmPos.no += sim.shares;
            else pmPos.yes += sim.shares;
            pm.set(pair.polymarketSlug, pmPos);
          }
        }
      }

      await hedgeOnce(pairs, feed, lmts, pm, poly, settings, recorder, lastHedgeAt);
      // After the first post-fill tick, the hedge has been decided+recorded.
      if (sim && simTick >= 2) simHedged = true;

      // -- Circuit breaker (live only): mark equity, trip on drawdown --
      if (!settings.dryRun && risk) {
        const [pUSD, baseUsd] = await Promise.all([
          poly.getCollateralBalance().catch(() => 0),
          walletAddress ? readBaseUsdc(walletAddress) : Promise.resolve(null),
        ]);
        let posValue = 0;
        for (const pair of pairs) {
          const mid = quoteMid(feed.getQuote(pair.polymarketSlug) ?? { bid: null, ask: null });
          posValue += markPairValue(
            lmts[pair.limitlessSlug] ?? { yes: 0, no: 0 },
            pm.get(pair.polymarketSlug) ?? { yes: 0, no: 0 },
            mid,
          );
        }
        const equity = baseUsd == null ? null : totalEquity({ pUSD, lmtsFreeUsd: baseUsd, posValue });
        const res = risk.update(equity);
        if (res.equity != null) {
          logger.info(
            { pnl: (res.pnl ?? 0).toFixed(2), equity: res.equity.toFixed(2), pUSD: pUSD.toFixed(2), posValue: posValue.toFixed(2) },
            'risk',
          );
          recorder?.record({
            kind: 'equity',
            pnl: res.pnl ?? 0,
            equity: res.equity,
            pUSD,
            lmtsFreeUsd: baseUsd ?? 0,
            posValue,
          });
        }
        if (res.tripped) {
          logger.error('circuit breaker tripped — aborting run (cancel-all on shutdown)');
          onKill?.();
          break;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'hedger tick failed');
    }
  }
}
