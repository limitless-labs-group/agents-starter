/**
 * SDKTradingClient — thin adapter over `@limitless-exchange/sdk`.
 *
 * Lives alongside the legacy hand-rolled `TradingClient` so strategies can
 * opt in one at a time. The hand-rolled client (`./trading.ts`) is unchanged
 * and remains the default until each strategy is migrated.
 *
 * Why this exists:
 *   - The hand-rolled client duplicates work the SDK already does well
 *     (venue/exchange routing, retry/queueing, tick alignment, type cleanup).
 *   - Sign parity is proven byte-identical between the SDK and the viem-based
 *     hand-rolled signer — see `tests/unit/sign-parity.test.ts`. So switching
 *     a strategy from one to the other does not change on-chain order
 *     semantics.
 *   - The SDK is npm-published (`@limitless-exchange/sdk@^1.0.9`) and tracks
 *     backend changes the hand-rolled code would silently drift from.
 *
 * Public surface intentionally narrow for Phase 1:
 *   - `createOrder(...)` — GTC / FOK / FAK with explicit price+size or
 *     usd notional.
 *   - `cancelOrder(orderId)` / `cancelAll(slug)`.
 *   - `getWalletAddress()` / `getOwnerId()`.
 *
 * Anything else (positions, websocket, markets) should be added on demand
 * as strategies migrate. Each addition is a thin pass-through to the
 * corresponding SDK service from the shared `Client` instance.
 */

import { ethers } from 'ethers';
import {
  Client,
  HttpClient,
  OrderClient,
  OrderType,
  Side,
  type OrderResponse,
} from '@limitless-exchange/sdk';
import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'sdk-trading',
});

/**
 * Config for constructing an SDKTradingClient.
 *
 * Auth: prefer **scoped HMAC token credentials** (`hmacCredentials`). Plain
 * API keys are deprecated on Limitless (no longer issued) — `apiKey` is kept
 * only as a legacy fallback for users who already hold one. You must provide
 * one or the other.
 *
 * @see https://docs.limitless.exchange/developers/authentication
 */
export interface SDKTradingConfig {
  privateKey: string;
  /**
   * Scoped API-token credentials for HMAC request signing (current method).
   * Derive via `POST /auth/api-tokens/derive`; you receive `{ tokenId, secret }`.
   */
  hmacCredentials?: { tokenId: string; secret: string };
  /**
   * Legacy `X-API-Key` value. Deprecated — only used when `hmacCredentials`
   * is absent. New Limitless users cannot obtain one.
   */
  apiKey?: string;
  apiBaseUrl?: string;
  /**
   * Log-only mode: no orders signed or sent. Single source of truth — pass
   * the caller's resolved dry-run decision (e.g. settings.dryRun). Falls back
   * to `process.env.DRY_RUN === 'true'` so standalone callers still work, but
   * passing it explicitly avoids the trap where env and config disagree and
   * the client trades live while the rest of the system thinks it's dry.
   */
  dryRun?: boolean;
}

/**
 * Resolve auth from explicit config or environment, preferring HMAC.
 *
 * Env precedence: `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET` (HMAC) over
 * `LIMITLESS_API_KEY` (legacy).
 */
export function resolveAuth(config: SDKTradingConfig): {
  hmacCredentials?: { tokenId: string; secret: string };
  apiKey?: string;
} {
  if (config.hmacCredentials) {
    return { hmacCredentials: config.hmacCredentials };
  }
  const envTokenId = process.env.LMTS_TOKEN_ID;
  const envTokenSecret = process.env.LMTS_TOKEN_SECRET;
  if (envTokenId && envTokenSecret) {
    return { hmacCredentials: { tokenId: envTokenId, secret: envTokenSecret } };
  }
  if (config.apiKey) {
    return { apiKey: config.apiKey };
  }
  if (process.env.LIMITLESS_API_KEY) {
    return { apiKey: process.env.LIMITLESS_API_KEY };
  }
  return {};
}

/**
 * Strategy-level order parameters. Same shape as the legacy CreateOrderParams
 * but typed against the SDK enums.
 */
export interface SDKCreateOrderParams {
  marketSlug: string;
  side: 'YES' | 'NO';
  /** Limit price in CENTS (e.g. 55 = 0.55). Matches the legacy client. */
  limitPriceCents: number;
  /** USD notional in whole dollars (e.g. 2 = $2). */
  usdAmount: number;
  orderType?: 'GTC' | 'FOK' | 'FAK';
  /** Only honored for GTC. */
  postOnly?: boolean;
}

export class SDKTradingClient {
  private readonly client: Client;
  private readonly orderClient: OrderClient;
  private readonly wallet: ethers.Wallet;
  private readonly dryRun: boolean;

  constructor(config: SDKTradingConfig) {
    if (!config.privateKey) {
      throw new Error('SDKTradingClient: privateKey is required');
    }
    this.dryRun = config.dryRun ?? process.env.DRY_RUN === 'true';

    const auth = resolveAuth(config);
    if (!auth.hmacCredentials && !auth.apiKey) {
      throw new Error(
        'SDKTradingClient: no auth configured. Provide hmacCredentials ' +
          '({ tokenId, secret }) — preferred — or set LMTS_TOKEN_ID + ' +
          'LMTS_TOKEN_SECRET in the environment. Legacy: apiKey / LIMITLESS_API_KEY.',
      );
    }

    const http = new HttpClient({
      baseURL: config.apiBaseUrl || process.env.LIMITLESS_API_URL,
      ...(auth.hmacCredentials
        ? { hmacCredentials: auth.hmacCredentials }
        : { apiKey: auth.apiKey }),
    });

    this.client = Client.fromHttpClient(http);
    this.wallet = new ethers.Wallet(config.privateKey);

    if (auth.apiKey && !auth.hmacCredentials) {
      logger.warn(
        'SDKTradingClient: using deprecated X-API-Key auth. Limitless no ' +
          'longer issues these — migrate to a scoped HMAC token ' +
          '(LMTS_TOKEN_ID + LMTS_TOKEN_SECRET). See docs.limitless.exchange/developers/authentication.',
      );
    }

    // Pass the private key string (not the Wallet object) to side-step the
    // SDK's CJS Wallet type vs our ESM Wallet type mismatch. The SDK
    // re-constructs the Wallet internally with the same key, so identity is
    // preserved.
    this.orderClient = this.client.newOrderClient(config.privateKey);

    logger.info(
      { address: this.wallet.address },
      'SDKTradingClient initialized'
    );
  }

  /** EOA address the wallet signs as. */
  getWalletAddress(): string {
    return this.wallet.address;
  }

  /** Internal user id, only set after the first order. */
  getOwnerId(): number | undefined {
    return this.orderClient.ownerId;
  }

  /**
   * Place an order via the SDK. Behaviorally equivalent to the legacy
   * `TradingClient.createOrder` for GTC, FAK, and FOK paths.
   *
   * GTC tick alignment, FOK takerAmount=1 semantics, venue-driven
   * verifyingContract, and user-id caching are all handled inside the SDK's
   * OrderBuilder + OrderClient — we just pass intent.
   */
  async createOrder(params: SDKCreateOrderParams): Promise<OrderResponse> {
    const {
      marketSlug,
      side,
      limitPriceCents,
      usdAmount,
      orderType = 'FOK',
      postOnly,
    } = params;

    // Resolve YES/NO → tokenId by fetching the market.
    // The SDK returns either { positionIds: [yes, no] } or { tokens: { yes, no } }
    // depending on market vintage. Read both defensively.
    const market = (await this.client.markets.getMarket(marketSlug)) as unknown as {
      positionIds?: string[];
      tokens?: { yes?: string; no?: string };
    };
    const yesToken = market.positionIds?.[0] ?? market.tokens?.yes;
    const noToken = market.positionIds?.[1] ?? market.tokens?.no;
    if (!yesToken || !noToken) {
      throw new Error(
        `SDKTradingClient: market ${marketSlug} has no valid yes/no token ids`,
      );
    }
    const tokenId = side === 'YES' ? yesToken : noToken;

    const price = limitPriceCents / 100;

    if (this.dryRun) {
      logger.info(
        { marketSlug, side, price, usdAmount, orderType },
        '[DRY_RUN] would createOrder via SDK'
      );
      return {
        order: {
          id: `dry-run-${Date.now()}`,
          createdAt: new Date().toISOString(),
          makerAmount: 0,
          takerAmount: 0,
          expiration: '0',
          signatureType: 0,
          salt: 0,
          maker: this.wallet.address,
          signer: this.wallet.address,
          taker: '0x0000000000000000000000000000000000000000',
          tokenId,
          side: side === 'YES' ? Side.BUY : Side.BUY, // strategy always buys YES or NO
          feeRateBps: 300,
          nonce: 0,
          signature: '0x',
          orderType,
          price,
          marketId: 0, // unknown in DRY_RUN; real value comes from the API in live mode
        },
      };
    }

    // Map our orderType string → SDK OrderType enum + branch on shape.
    // FOK uses USD notional (makerAmount as dollars); GTC/FAK use price+size.
    if (orderType === 'FOK') {
      const res = await this.orderClient.createOrder({
        tokenId,
        side: Side.BUY,
        orderType: OrderType.FOK,
        makerAmount: usdAmount, // SDK handles micro-USDC scaling internally
        marketSlug,
      } as any);
      logger.info(
        { marketSlug, side, price, usdAmount, orderType, orderId: (res as OrderResponse)?.order?.id },
        'createOrder placed',
      );
      return res;
    }

    // GTC / FAK: size in contracts, price as decimal.
    // SDK's OrderBuilder tick-aligns automatically.
    const size = usdAmount / price;
    const res = await this.orderClient.createOrder({
      tokenId,
      price,
      size,
      side: Side.BUY,
      orderType: orderType === 'GTC' ? OrderType.GTC : OrderType.FAK,
      marketSlug,
      ...(orderType === 'GTC' && postOnly ? { postOnly: true } : {}),
    } as any);
    logger.info(
      { marketSlug, side, price, size, orderType, orderId: (res as OrderResponse)?.order?.id },
      'createOrder placed',
    );
    return res;
  }

  /** Cancel a single order by ID. */
  async cancelOrder(orderId: string): Promise<{ message: string }> {
    if (this.dryRun) {
      logger.info({ orderId }, '[DRY_RUN] would cancelOrder');
      return { message: 'dry-run' };
    }
    return await this.orderClient.cancel(orderId);
  }

  /** Cancel every live order on a market. */
  async cancelAll(marketSlug: string): Promise<{ message: string }> {
    if (this.dryRun) {
      logger.info({ marketSlug }, '[DRY_RUN] would cancelAll');
      return { message: 'dry-run' };
    }
    const res = await this.orderClient.cancelAll(marketSlug);
    logger.debug({ marketSlug }, 'cancelAll done');
    return res;
  }

  /** Count live (resting) orders on a market. Returns -1 if the read fails. */
  async countLiveOrders(marketSlug: string): Promise<number> {
    try {
      const positions = (await this.client.portfolio.getCLOBPositions()) as unknown as Array<{
        market?: { slug?: string };
        orders?: { liveOrders?: unknown[] };
      }>;
      let n = 0;
      for (const p of positions ?? []) {
        if (p.market?.slug === marketSlug) n += p.orders?.liveOrders?.length ?? 0;
      }
      return n;
    } catch (err) {
      logger.warn({ err: (err as Error).message, marketSlug }, 'countLiveOrders read failed');
      return -1;
    }
  }

  /**
   * Cancel-all, then VERIFY nothing is still resting and retry if so. A single
   * cancelAll has been observed to silently leave orders on the book — for an
   * unattended bot that means orphaned live orders on shutdown. Retries up to
   * `attempts` times with a short backoff; logs loudly if it can't confirm clean.
   */
  async cancelAllAndVerify(
    marketSlug: string,
    attempts = 6,
  ): Promise<{ message: string; remaining: number }> {
    if (this.dryRun) {
      logger.info({ marketSlug }, '[DRY_RUN] would cancelAllAndVerify');
      return { message: 'dry-run', remaining: 0 };
    }
    for (let i = 1; i <= attempts; i++) {
      await this.orderClient.cancelAll(marketSlug).catch((err) => {
        logger.warn({ err: (err as Error).message, marketSlug, attempt: i }, 'cancelAll call failed');
      });
      const remaining = await this.countLiveOrders(marketSlug);
      if (remaining === 0) {
        logger.info({ marketSlug, attempt: i }, 'cancelAll verified clean');
        return { message: 'ok', remaining: 0 };
      }
      logger.warn(
        { marketSlug, remaining, attempt: i },
        remaining < 0 ? 'cancelAll could not verify (read failed) — retrying' : 'cancelAll left orders — retrying',
      );
      // Escalating backoff — outlast backend place/cancel propagation lag,
      // which is what was leaving orphans with a fixed short retry.
      await new Promise((r) => setTimeout(r, 400 * i));
    }
    const remaining = await this.countLiveOrders(marketSlug);
    if (remaining !== 0) {
      logger.error({ marketSlug, remaining }, 'cancelAllAndVerify could NOT confirm a clean book');
    }
    return { message: remaining === 0 ? 'ok' : 'incomplete', remaining };
  }
}
