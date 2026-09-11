/**
 * Shared construction of the official `@limitless-exchange/sdk` clients.
 *
 * Every module in `src/core/limitless/` builds on the SDK rather than on
 * hand-rolled HTTP: the SDK owns HMAC request signing (`lmts-api-key` /
 * `lmts-timestamp` / `lmts-signature`), EIP-712 order signing, venue routing,
 * retries, and the typed wire shapes. This file is the one place that turns
 * environment variables into SDK clients so strategies, scripts, and tests
 * all resolve auth the same way.
 *
 * Auth precedence (HMAC first, legacy last):
 *   1. explicit `hmacCredentials` passed by the caller
 *   2. `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET` from the environment
 *   3. explicit `apiKey` passed by the caller (legacy `X-API-Key`)
 *   4. `LIMITLESS_API_KEY` from the environment (legacy)
 *
 * Public market reads work with no auth at all, so `createSdkClient()` never
 * throws on missing credentials; callers that need auth check `hasAuth()`.
 *
 * @see https://docs.limitless.exchange/developers/authentication
 */

import {
  Client,
  HttpClient,
  WebSocketClient,
  type HMACCredentials,
  type ILogger,
} from '@limitless-exchange/sdk';
import type { Logger } from 'pino';

export const DEFAULT_API_URL = 'https://api.limitless.exchange';
export const DEFAULT_WS_URL = 'wss://ws.limitless.exchange';

export interface LimitlessAuth {
  /** Scoped HMAC token credentials (current method). */
  hmacCredentials?: HMACCredentials;
  /** Legacy `X-API-Key`. Only honored when no HMAC credentials resolve. */
  apiKey?: string;
}

export interface LimitlessClientOptions extends LimitlessAuth {
  /** REST base URL. Defaults to `LIMITLESS_API_URL` or the production API. */
  baseURL?: string;
  /** WebSocket URL. Defaults to `LIMITLESS_WS_URL` or the production gateway. */
  wsUrl?: string;
  /** Optional pino logger to route SDK logs through. */
  logger?: Logger;
}

type EnvLike = Record<string, string | undefined>;

/** Resolve auth from explicit values and the environment, HMAC first. */
export function resolveAuth(overrides: LimitlessAuth = {}, env: EnvLike = process.env): LimitlessAuth {
  if (overrides.hmacCredentials) return { hmacCredentials: overrides.hmacCredentials };
  if (env.LMTS_TOKEN_ID && env.LMTS_TOKEN_SECRET) {
    return { hmacCredentials: { tokenId: env.LMTS_TOKEN_ID, secret: env.LMTS_TOKEN_SECRET } };
  }
  if (overrides.apiKey) return { apiKey: overrides.apiKey };
  if (env.LIMITLESS_API_KEY) return { apiKey: env.LIMITLESS_API_KEY };
  return {};
}

/** True when any credential resolved (HMAC or legacy). */
export function hasAuth(auth: LimitlessAuth): boolean {
  return Boolean(auth.hmacCredentials || auth.apiKey);
}

/** True when the resolved auth is the legacy `X-API-Key` path. */
export function isLegacyAuth(auth: LimitlessAuth): boolean {
  return Boolean(auth.apiKey && !auth.hmacCredentials);
}

export function getApiBaseUrl(override?: string): string {
  return override || process.env.LIMITLESS_API_URL || DEFAULT_API_URL;
}

export function getWsUrl(override?: string): string {
  return override || process.env.LIMITLESS_WS_URL || DEFAULT_WS_URL;
}

/** Adapt a pino logger to the SDK's `ILogger` interface. */
export function toSdkLogger(logger: Logger): ILogger {
  return {
    debug: (message, meta) => logger.debug(meta ?? {}, message),
    info: (message, meta) => logger.info(meta ?? {}, message),
    warn: (message, meta) => logger.warn(meta ?? {}, message),
    error: (message, error, meta) => logger.error({ ...(meta ?? {}), err: error?.message }, message),
  };
}

/**
 * Build the root SDK `Client` (markets, portfolio, pages, apiTokens,
 * partnerAccounts, delegatedOrders, serverWallets) from env + overrides.
 */
export function createSdkClient(options: LimitlessClientOptions = {}): Client {
  const auth = resolveAuth(options);
  const http = new HttpClient({
    baseURL: getApiBaseUrl(options.baseURL),
    ...(auth.hmacCredentials ? { hmacCredentials: auth.hmacCredentials } : {}),
    ...(auth.apiKey && !auth.hmacCredentials ? { apiKey: auth.apiKey } : {}),
    ...(options.logger ? { logger: toSdkLogger(options.logger) } : {}),
  });
  return Client.fromHttpClient(http);
}

/**
 * Build the SDK `WebSocketClient`. Public channels need no auth; the
 * authenticated channels (`subscribe_order_events`, `subscribe_positions`)
 * need HMAC credentials, which the SDK uses to sign the handshake.
 */
export function createWebSocketClient(options: LimitlessClientOptions = {}): WebSocketClient {
  const auth = resolveAuth(options);
  return new WebSocketClient(
    {
      url: getWsUrl(options.wsUrl),
      autoReconnect: true,
      ...(auth.hmacCredentials ? { hmacCredentials: auth.hmacCredentials } : {}),
      ...(auth.apiKey && !auth.hmacCredentials ? { apiKey: auth.apiKey } : {}),
    },
    options.logger ? toSdkLogger(options.logger) : undefined,
  );
}
