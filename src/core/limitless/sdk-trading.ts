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
 * Pulls sensible defaults from the same env vars the legacy client uses, so
 * dropping this into an existing strategy requires no env changes.
 */
export interface SDKTradingConfig {
  privateKey: string;
  apiKey: string;
  apiBaseUrl?: string;
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

  constructor(config: SDKTradingConfig) {
    if (!config.privateKey) {
      throw new Error('SDKTradingClient: privateKey is required');
    }
    if (!config.apiKey) {
      throw new Error('SDKTradingClient: apiKey is required');
    }

    const http = new HttpClient({
      baseURL: config.apiBaseUrl || process.env.LIMITLESS_API_URL,
      apiKey: config.apiKey,
    });

    this.client = Client.fromHttpClient(http);
    this.wallet = new ethers.Wallet(config.privateKey);

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
    const market = await this.client.markets.getMarket(marketSlug);
    if (!market.positionIds || market.positionIds.length < 2) {
      throw new Error(
        `SDKTradingClient: market ${marketSlug} has no valid positionIds`
      );
    }
    const tokenId =
      side === 'YES' ? market.positionIds[0] : market.positionIds[1];

    const price = limitPriceCents / 100;

    if (process.env.DRY_RUN === 'true') {
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
      return await this.orderClient.createOrder({
        tokenId,
        side: Side.BUY,
        orderType: OrderType.FOK,
        makerAmount: usdAmount, // SDK handles micro-USDC scaling internally
        marketSlug,
      } as any);
    }

    // GTC / FAK: size in contracts, price as decimal.
    // SDK's OrderBuilder tick-aligns automatically.
    const size = usdAmount / price;
    return await this.orderClient.createOrder({
      tokenId,
      price,
      size,
      side: Side.BUY,
      orderType: orderType === 'GTC' ? OrderType.GTC : OrderType.FAK,
      marketSlug,
      ...(orderType === 'GTC' && postOnly ? { postOnly: true } : {}),
    } as any);
  }

  /** Cancel a single order by ID. */
  async cancelOrder(orderId: string): Promise<{ message: string }> {
    if (process.env.DRY_RUN === 'true') {
      logger.info({ orderId }, '[DRY_RUN] would cancelOrder');
      return { message: 'dry-run' };
    }
    return await this.orderClient.cancel(orderId);
  }

  /** Cancel every live order on a market. */
  async cancelAll(marketSlug: string): Promise<{ message: string }> {
    if (process.env.DRY_RUN === 'true') {
      logger.info({ marketSlug }, '[DRY_RUN] would cancelAll');
      return { message: 'dry-run' };
    }
    return await this.orderClient.cancelAll(marketSlug);
  }
}
