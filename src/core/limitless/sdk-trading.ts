/**
 * SDKTradingClient — order placement, cancellation, and fill tracking over
 * the official `@limitless-exchange/sdk`.
 *
 * The SDK owns the hard parts: EIP-712 order signing against the market's
 * venue (`verifyingContract`), HMAC request signing, tick alignment, FOK
 * `takerAmount` semantics, and profile-id caching. This class adds the
 * strategy-facing vocabulary (YES/NO side, price in cents, USD notional),
 * the `DRY_RUN` gate, and the fill-tracking helpers that the SDK does not
 * ship yet (`POST /orders/status/batch`, taker-delay aware waiting).
 *
 * Every write path short-circuits when `dryRun` is true: nothing is signed,
 * nothing is sent. Pass the caller's resolved dry-run flag explicitly so env
 * and config can never disagree.
 */

import { ethers } from 'ethers';
import {
  CancelReplaceMode,
  OrderType as SdkOrderType,
  Side,
  type CancelReplaceResponse,
  type Client,
  type Execution,
  type OrderClient,
  type OrderResponse,
  type OrderMatch,
} from '@limitless-exchange/sdk';
import { pino } from 'pino';
import {
  createSdkClient,
  hasAuth,
  isLegacyAuth,
  resolveAuth as resolveLimitlessAuth,
  type LimitlessAuth,
} from './client.js';
import { classifyExecution, isTerminalState, summarizeExecution, type ExecutionSummary } from './execution.js';
import { marketTokenIds, type OrderType, type OutcomeSide } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'sdk-trading',
});

/** Shares are quantized to 0.001; the SDK rejects sizes off that grid. */
const SHARE_GRID = 1000;

export interface SDKTradingConfig extends LimitlessAuth {
  /** EOA private key that signs orders. The profile must be in `eoa` trading-wallet mode. */
  privateKey: string;
  apiBaseUrl?: string;
  /**
   * Log-only mode: no orders signed or sent. Falls back to
   * `process.env.DRY_RUN === 'true'` so standalone callers still work.
   */
  dryRun?: boolean;
  /** Reuse an existing SDK client instead of building one from env. */
  sdk?: Client;
}

/**
 * Resolve auth from explicit config or environment, preferring HMAC.
 * Precedence: config HMAC → env `LMTS_TOKEN_ID`/`LMTS_TOKEN_SECRET` →
 * config `apiKey` → env `LIMITLESS_API_KEY`.
 */
export function resolveAuth(config: LimitlessAuth): LimitlessAuth {
  return resolveLimitlessAuth(config);
}

/** Strategy-level BUY parameters (the common case: buy YES or NO). */
export interface SDKCreateOrderParams {
  marketSlug: string;
  side: OutcomeSide;
  /** Limit price in CENTS (e.g. 55 = $0.55). */
  limitPriceCents: number;
  /** USD notional to spend (e.g. 2 = $2). */
  usdAmount: number;
  /** Defaults to FOK. */
  orderType?: OrderType;
  /** GTC only: reject instead of crossing the book. */
  postOnly?: boolean;
}

export interface SellSharesParams {
  marketSlug: string;
  side: OutcomeSide;
  shares: number;
  /** Limit price in CENTS; sells at this price or better. */
  limitPriceCents: number;
  /** Defaults to FAK (take resting bids immediately). */
  orderType?: 'GTC' | 'FAK';
  postOnly?: boolean;
}

export interface CancelReplaceOrderParams {
  /** Exactly one of `orderId` / `clientOrderId` identifies the resting order to cancel. */
  orderId?: string;
  clientOrderId?: string;
  marketSlug: string;
  side: OutcomeSide;
  action?: 'BUY' | 'SELL';
  /** Replacement limit price in CENTS. */
  limitPriceCents: number;
  /** Replacement size in shares. */
  shares: number;
  orderType?: 'GTC' | 'FAK';
  postOnly?: boolean;
  /** `STOP_ON_FAILURE` (default) skips the replacement if the cancel fails. */
  mode?: 'STOP_ON_FAILURE' | 'ALLOW_FAILURE';
}

/** One item of `POST /orders/status/batch`. */
export interface OrderStatusResult {
  index: number;
  status: 'found' | 'not_found' | 'invalid';
  orderId?: string;
  clientOrderId?: string;
  error?: string;
  data?: {
    execution: Execution & { reason?: string; stpMakerCancels?: string[] };
    makerMatches?: OrderMatch[];
    order: { id: string; orderType?: string; [key: string]: unknown };
  };
}

export interface AwaitFillOptions {
  /** Give up after this long. Default 60s. */
  timeoutMs?: number;
  /** Poll interval once eligible. Default 1.5s. */
  pollMs?: number;
  /** From `execution.eligibleAt`; polling starts after it. */
  eligibleAt?: string;
}

export class SDKTradingClient {
  /** The underlying SDK client (markets, portfolio, ...), shared with the order client. */
  readonly sdk: Client;
  private readonly orderClient: OrderClient;
  private readonly wallet: ethers.Wallet;
  private readonly dryRun: boolean;

  constructor(config: SDKTradingConfig) {
    if (!config.privateKey) {
      throw new Error('SDKTradingClient: privateKey is required');
    }
    this.dryRun = config.dryRun ?? process.env.DRY_RUN === 'true';

    const auth = resolveAuth(config);
    if (!hasAuth(auth)) {
      throw new Error(
        'SDKTradingClient: no auth configured. Provide hmacCredentials ' +
          '({ tokenId, secret }) — preferred — or set LMTS_TOKEN_ID + ' +
          'LMTS_TOKEN_SECRET in the environment. Legacy: apiKey / LIMITLESS_API_KEY.',
      );
    }
    if (isLegacyAuth(auth)) {
      logger.warn(
        'SDKTradingClient: using deprecated X-API-Key auth. Limitless no ' +
          'longer issues these — migrate to a scoped HMAC token ' +
          '(LMTS_TOKEN_ID + LMTS_TOKEN_SECRET). See docs.limitless.exchange/developers/authentication.',
      );
    }

    this.sdk = config.sdk ?? createSdkClient({ ...auth, baseURL: config.apiBaseUrl });
    this.wallet = new ethers.Wallet(config.privateKey);
    // Pass the key string, not the Wallet, so the SDK builds its own ethers
    // Wallet and no CJS/ESM type mismatch leaks into our build.
    this.orderClient = this.sdk.newOrderClient(config.privateKey);

    logger.info({ address: this.wallet.address, dryRun: this.dryRun }, 'SDKTradingClient initialized');
  }

  /** EOA address the wallet signs as. */
  getWalletAddress(): string {
    return this.wallet.address;
  }

  /** Internal profile id, only known after the first order. */
  getOwnerId(): number | undefined {
    return this.orderClient.ownerId;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  private async resolveTokenId(marketSlug: string, side: OutcomeSide): Promise<string> {
    const market = await this.sdk.markets.getMarket(marketSlug);
    const ids = marketTokenIds(market);
    return side === 'YES' ? ids.yes : ids.no;
  }

  /**
   * BUY `side` on a market. FOK spends `usdAmount` at the best available
   * price up to the limit; GTC/FAK convert `usdAmount / price` into shares.
   * Returns the SDK `OrderResponse`, whose `execution.settlementStatus` says
   * what happened (see `execution.ts`).
   */
  async createOrder(params: SDKCreateOrderParams): Promise<OrderResponse> {
    const { marketSlug, side, limitPriceCents, usdAmount, orderType = 'FOK', postOnly } = params;
    const price = limitPriceCents / 100;

    if (this.dryRun) {
      logger.info({ marketSlug, side, price, usdAmount, orderType }, '[DRY_RUN] would createOrder via SDK');
      return this.dryRunResponse('dry-run', Side.BUY, orderType, price);
    }
    const tokenId = await this.resolveTokenId(marketSlug, side);

    if (orderType === 'FOK') {
      const res = await this.orderClient.createOrder({
        tokenId,
        side: Side.BUY,
        orderType: SdkOrderType.FOK,
        makerAmount: usdAmount, // USD; the SDK scales to micro-USDC
        marketSlug,
      });
      this.logPlaced('createOrder placed', res, { marketSlug, side, price, usdAmount, orderType });
      return res;
    }

    const size = Math.round((usdAmount / price) * SHARE_GRID) / SHARE_GRID;
    const res = await this.orderClient.createOrder({
      tokenId,
      price,
      size,
      side: Side.BUY,
      orderType: orderType === 'GTC' ? SdkOrderType.GTC : SdkOrderType.FAK,
      marketSlug,
      ...(orderType === 'GTC' && postOnly ? { postOnly: true } : {}),
    });
    this.logPlaced('createOrder placed', res, { marketSlug, side, price, size, orderType });
    return res;
  }

  /**
   * SELL `shares` of a side to close inventory. Defaults to FAK at the limit
   * so it takes resting bids immediately. Requires the CTF `setApprovalForAll`
   * for the market's exchange (`npm start approve <slug>`).
   */
  async sellShares(params: SellSharesParams): Promise<OrderResponse> {
    const { marketSlug, side, shares, limitPriceCents, orderType = 'FAK', postOnly } = params;
    const price = limitPriceCents / 100;
    // Floor, never round up: asking to sell more than you hold is rejected.
    const size = Math.floor(shares * SHARE_GRID) / SHARE_GRID;

    if (this.dryRun) {
      logger.info({ marketSlug, side, price, size, orderType }, '[DRY_RUN] would SELL to close');
      return this.dryRunResponse('dry-run', Side.SELL, orderType, price, 'dry-run-sell');
    }
    const tokenId = await this.resolveTokenId(marketSlug, side);

    const res = await this.orderClient.createOrder({
      tokenId,
      price,
      size,
      side: Side.SELL,
      orderType: orderType === 'GTC' ? SdkOrderType.GTC : SdkOrderType.FAK,
      marketSlug,
      ...(orderType === 'GTC' && postOnly ? { postOnly: true } : {}),
    });
    this.logPlaced('sellShares (close) placed', res, { marketSlug, side, price, size, orderType });
    return res;
  }

  /**
   * Atomically cancel a resting order and submit its replacement
   * (`POST /orders/cancel-replace`). Keeps a quoting loop to one request per
   * re-quote instead of cancel + create.
   */
  async cancelReplace(params: CancelReplaceOrderParams): Promise<CancelReplaceResponse> {
    const {
      marketSlug,
      side,
      action = 'BUY',
      limitPriceCents,
      shares,
      orderType = 'GTC',
      postOnly,
      mode = 'STOP_ON_FAILURE',
    } = params;
    if (!params.orderId && !params.clientOrderId) {
      throw new Error('cancelReplace: orderId or clientOrderId is required');
    }
    const price = limitPriceCents / 100;
    const size = Math.round(shares * SHARE_GRID) / SHARE_GRID;
    const cancel = params.orderId ? { orderId: params.orderId } : { clientOrderId: params.clientOrderId! };

    if (this.dryRun) {
      logger.info({ ...cancel, marketSlug, side, action, price, size, orderType }, '[DRY_RUN] would cancelReplace');
      return {
        cancel: { status: 'SUCCESS', orderId: params.orderId ?? 'dry-run' },
        replacement: { status: 'NOT_ATTEMPTED' },
      };
    }
    const tokenId = await this.resolveTokenId(marketSlug, side);

    const res = await this.orderClient.cancelReplace({
      cancel,
      replacement: {
        tokenId,
        price,
        size,
        side: action === 'BUY' ? Side.BUY : Side.SELL,
        orderType: orderType === 'GTC' ? SdkOrderType.GTC : SdkOrderType.FAK,
        marketSlug,
        ...(orderType === 'GTC' && postOnly ? { postOnly: true } : {}),
      },
      mode: mode === 'ALLOW_FAILURE' ? CancelReplaceMode.ALLOW_FAILURE : CancelReplaceMode.STOP_ON_FAILURE,
    });
    logger.info(
      {
        marketSlug,
        cancel: res.cancel.status,
        replacement: res.replacement.status,
        newOrderId: res.replacement.data?.order?.id,
      },
      'cancelReplace done',
    );
    return res;
  }

  /**
   * Look up order state by id (`POST /orders/status/batch`, up to 50 items).
   * Each item carries `orderId` or `clientOrderId`, never both. This is the
   * REST way to observe a taker-delayed or resting order's fill; there is no
   * `GET /orders/:id`.
   */
  async getOrderStatuses(
    items: Array<{ orderId?: string; clientOrderId?: string }>,
  ): Promise<OrderStatusResult[]> {
    if (items.length === 0) return [];
    if (items.length > 50) throw new Error('getOrderStatuses: at most 50 items per call');
    if (this.dryRun) {
      logger.info({ count: items.length }, '[DRY_RUN] would query order statuses');
      return items.map((it, index) => ({ index, status: 'not_found', ...it }));
    }
    const res = await this.sdk.http.post<{ results: OrderStatusResult[] }>('/orders/status/batch', { items });
    return res.results ?? [];
  }

  /**
   * Wait for an order to reach a terminal state, polling `status/batch`.
   * Honors the taker delay: when `eligibleAt` is in the future, polling
   * starts after it. Resolves with the last observed summary either way, so
   * callers check `state` (`filled` / `killed` / `failed`, or `pending` on
   * timeout) rather than catching.
   */
  async awaitFill(orderId: string, orderType: OrderType, opts: AwaitFillOptions = {}): Promise<ExecutionSummary> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const pollMs = opts.pollMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;

    if (this.dryRun) {
      return summarizeExecution(undefined, orderType);
    }

    if (opts.eligibleAt) {
      const wait = new Date(opts.eligibleAt).getTime() - Date.now();
      if (wait > 0) await sleep(Math.min(wait, timeoutMs));
    }

    let last: ExecutionSummary = summarizeExecution(undefined, orderType);
    while (Date.now() < deadline) {
      const [result] = await this.getOrderStatuses([{ orderId }]);
      if (result?.status === 'found' && result.data) {
        last = summarizeExecution(result.data.execution, orderType);
        if (isTerminalState(last.state) || last.state === 'resting') return last;
      } else if (result?.status === 'invalid') {
        throw new Error(`awaitFill: invalid order id ${orderId}: ${result.error ?? ''}`);
      }
      await sleep(pollMs);
    }
    logger.warn({ orderId, state: last.state }, 'awaitFill timed out before a terminal state');
    return last;
  }

  /** Read held YES/NO shares for a market from the positions snapshot. */
  async getPositionTokens(marketSlug: string): Promise<{ yes: number; no: number }> {
    const positions = await this.sdk.portfolio.getCLOBPositions();
    for (const p of positions ?? []) {
      if (p.market?.slug === marketSlug) {
        return {
          yes: Number(p.tokensBalance?.yes ?? 0) / 1e6,
          no: Number(p.tokensBalance?.no ?? 0) / 1e6,
        };
      }
    }
    return { yes: 0, no: 0 };
  }

  /**
   * Like getPositionTokens but waits for the balance to SETTLE — polls until
   * two consecutive reads agree (within the share grid) or maxTries is hit.
   * Use before acting on a fill so a lagged read cannot cause a double-fill.
   */
  async getPositionTokensSettled(
    marketSlug: string,
    opts: { maxTries?: number; delayMs?: number } = {},
  ): Promise<{ yes: number; no: number }> {
    const maxTries = Math.max(2, opts.maxTries ?? 4);
    const delayMs = opts.delayMs ?? 2500;
    let prev = await this.getPositionTokens(marketSlug);
    for (let i = 1; i < maxTries; i++) {
      await sleep(delayMs);
      const cur = await this.getPositionTokens(marketSlug);
      if (Math.abs(cur.yes - prev.yes) < 0.001 && Math.abs(cur.no - prev.no) < 0.001) return cur;
      prev = cur;
    }
    return prev;
  }

  /** Cancel a single order by ID. */
  async cancelOrder(orderId: string): Promise<{ message: string }> {
    if (this.dryRun) {
      logger.info({ orderId }, '[DRY_RUN] would cancelOrder');
      return { message: 'dry-run' };
    }
    return this.orderClient.cancel(orderId);
  }

  /** Cancel every live order on one market (cancel-all is per slug). */
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
      const positions = await this.sdk.portfolio.getCLOBPositions();
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
   * cancelAll has been observed to leave orders on the book under propagation
   * lag; an unattended bot must not leave orphans on shutdown.
   */
  async cancelAllAndVerify(marketSlug: string, attempts = 6): Promise<{ message: string; remaining: number }> {
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
      await sleep(400 * i); // escalating backoff outlasts place/cancel propagation lag
    }
    const remaining = await this.countLiveOrders(marketSlug);
    if (remaining !== 0) {
      logger.error({ marketSlug, remaining }, 'cancelAllAndVerify could NOT confirm a clean book');
    }
    return { message: remaining === 0 ? 'ok' : 'incomplete', remaining };
  }

  private logPlaced(msg: string, res: OrderResponse, ctx: Record<string, unknown>): void {
    const summary = summarizeExecution(res, (ctx.orderType as OrderType) ?? 'GTC');
    logger.info(
      {
        ...ctx,
        orderId: res?.order?.id,
        settlementStatus: summary.settlementStatus,
        state: summary.state,
        ...(summary.eligibleAt ? { eligibleAt: summary.eligibleAt } : {}),
      },
      msg,
    );
  }

  private dryRunResponse(
    tokenId: string,
    side: Side,
    orderType: OrderType,
    price: number,
    idPrefix = 'dry-run',
  ): OrderResponse {
    return {
      order: {
        id: `${idPrefix}-${Date.now()}`,
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
        side,
        feeRateBps: 0,
        nonce: 0,
        signature: '0x',
        orderType,
        price,
        marketId: 0,
      },
    };
  }
}

/** Re-exported so callers can reason about a response without importing execution.ts. */
export { classifyExecution, summarizeExecution };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
