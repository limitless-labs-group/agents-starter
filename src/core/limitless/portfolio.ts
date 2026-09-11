/**
 * PortfolioClient — authenticated reads about *your* account.
 *
 * Wraps the SDK's `PortfolioFetcher` (`GET /profiles/me`, `/portfolio/positions`,
 * `/portfolio/history`) and adds the one profile write a bot needs:
 * switching the trading-wallet mode to `eoa`, without which self-signed API
 * orders are rejected with "Signer does not match - you should use embedded
 * address for smart wallet".
 *
 * Every call needs auth (a scoped HMAC token). Construct with an existing SDK
 * `Client` to share one connection with the trading client.
 *
 * @see https://docs.limitless.exchange/developers/eip712-signing#trading-wallet-mode-whose-address-signs
 */

import type { Client, CLOBPosition, PortfolioPositionsResponse, UserProfile } from '@limitless-exchange/sdk';
import type { AxiosInstance } from 'axios';
import { pino } from 'pino';
import { createSdkClient, type LimitlessClientOptions } from './client.js';
import type { OutcomeSide } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'limitless-portfolio' });

export type TradeWalletMode = 'eoa' | 'smartWallet';

export interface PositionTokens {
  /** YES shares held (human units, 6-decimal precision). */
  yes: number;
  /** NO shares held. */
  no: number;
}

export class PortfolioClient {
  readonly sdk: Client;

  constructor(sdkOrOptions: Client | LimitlessClientOptions = {}) {
    this.sdk = isSdkClient(sdkOrOptions) ? sdkOrOptions : createSdkClient(sdkOrOptions);
  }

  /** The authenticated caller's private profile (`GET /profiles/me`). */
  async getProfile(): Promise<UserProfile> {
    return this.sdk.portfolio.getProfile();
  }

  /** Full positions payload: CLOB + AMM + group positions, points, rewards. */
  async getPositions(): Promise<PortfolioPositionsResponse> {
    return this.sdk.portfolio.getPositions();
  }

  /** CLOB positions only. */
  async getClobPositions(): Promise<CLOBPosition[]> {
    return this.sdk.portfolio.getCLOBPositions();
  }

  /** Cursor-paginated activity (`GET /portfolio/history`), newest first, MINED events only. */
  async getHistory(cursor?: string, limit = 20) {
    return this.sdk.portfolio.getUserHistory(cursor, limit);
  }

  /** YES/NO shares held on one market, read from the positions snapshot. */
  async getPositionTokens(marketSlug: string): Promise<PositionTokens> {
    const positions = await this.getClobPositions();
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
   * Whether a BUY on `side` has produced a position. The positions snapshot
   * is the ground truth for resting (GTC) fills, which do not show up on the
   * synchronous create-order response.
   */
  async verifyFill(marketSlug: string, side: OutcomeSide): Promise<{ filled: boolean; shares: number }> {
    const tokens = await this.getPositionTokens(marketSlug);
    const shares = side === 'YES' ? tokens.yes : tokens.no;
    return { filled: shares > 0, shares };
  }

  /** Current trading-wallet mode from the profile. `undefined` when the API omits it. */
  async getTradeWalletMode(): Promise<TradeWalletMode | undefined> {
    const profile = await this.getProfile();
    const mode = profile.tradeWalletOption;
    return mode === 'eoa' || mode === 'smartWallet' ? mode : undefined;
  }

  /**
   * Switch the profile's trading-wallet mode (`PUT /profiles`). Bots that sign
   * with `PRIVATE_KEY` need `eoa`. The switch is immediate and reversible.
   *
   * The SDK's `HttpClient` exposes no `put` helper, so this goes through the
   * SDK's underlying axios instance; its interceptor signs every verb.
   */
  async setTradeWalletMode(mode: TradeWalletMode): Promise<UserProfile> {
    const axios = (this.sdk.http as unknown as { client: AxiosInstance }).client;
    const res = await axios.put<UserProfile>('/profiles', { tradeWalletOption: mode });
    logger.info({ mode }, 'trade wallet mode updated');
    return res.data;
  }
}

function isSdkClient(value: Client | LimitlessClientOptions): value is Client {
  return typeof (value as Client).portfolio?.getProfile === 'function';
}
