/**
 * Pure helpers for reading a create-order result.
 *
 * `POST /orders` returns `execution.settlementStatus`, and that string (not
 * `execution.matched`) is what to branch on:
 *
 *   MINED / CONFIRMED  → the taker order settled on-chain; done.
 *   UNMATCHED          → FOK/FAK: nothing filled (terminal). GTC: resting on the book (live).
 *   DELAYED            → accepted but held by the market's taker delay; released at
 *                        `eligibleAt`. Not an error. Observe the fill later via the
 *                        order-events websocket or `POST /orders/status/batch`.
 *   MATCHED / RETRYING → provisional; keep watching.
 *   FAILED / CANCELED  → terminal failure (CANCELED = self-trade prevention).
 *
 * There is no machine-readable error code on rejected orders: those come back as
 * an HTTP status plus a `message` string. Branch on the status code, not the text.
 *
 * @see https://docs.limitless.exchange/developers/build-a-trading-agent (taker delay note)
 */

import type { Execution, OrderResponse } from '@limitless-exchange/sdk';
import type { OrderType } from './types.js';

export type FillState =
  /** Settled on-chain (MINED / CONFIRMED). */
  | 'filled'
  /** GTC resting on the book, nothing crossed yet. */
  | 'resting'
  /** Held by taker delay, or matched but not yet mined. Keep watching. */
  | 'pending'
  /** FOK/FAK that did not fill, or an STP cancel. Nothing happened. */
  | 'killed'
  /** Settlement failed. */
  | 'failed'
  /** A status this code does not know about (the server adds values over time). */
  | 'unknown';

const RESTING_TYPES: OrderType[] = ['GTC'];

/** Classify a settlement status for a given order type. */
export function classifyExecution(settlementStatus: string | undefined, orderType: OrderType): FillState {
  switch (settlementStatus) {
    case 'MINED':
    case 'CONFIRMED':
      return 'filled';
    case 'UNMATCHED':
      return RESTING_TYPES.includes(orderType) ? 'resting' : 'killed';
    case 'DELAYED':
    case 'RETRYING':
    case 'MATCHED':
      return 'pending';
    case 'CANCELED':
      return 'killed';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** True when the order can no longer change state. */
export function isTerminalState(state: FillState): boolean {
  return state === 'filled' || state === 'killed' || state === 'failed';
}

export interface ExecutionSummary {
  state: FillState;
  settlementStatus?: string;
  /** Contracts received net of fee (BUY) or sold (SELL), in shares. */
  contracts: number;
  /** USDC spent (BUY) or received net of fee (SELL). */
  usd: number;
  /** Size-weighted average fill price, 0..1, or null when nothing filled. */
  avgPrice: number | null;
  /** Fee actually applied, in basis points. */
  effectiveFeeBps?: number;
  /** When a DELAYED order is released to the matching engine. */
  eligibleAt?: string;
  txHash?: string | null;
  reason?: string;
}

/** Summarize an `OrderResponse` (or a bare `Execution`) into human units. */
export function summarizeExecution(
  input: OrderResponse | Execution | undefined,
  orderType: OrderType,
): ExecutionSummary {
  const execution = input && 'order' in input ? input.execution : (input as Execution | undefined);
  const state = classifyExecution(execution?.settlementStatus, orderType);
  const totals = execution?.totalsRaw;
  const contractsGross = Number(totals?.contractsGross ?? 0) / 1e6;
  const contractsNet = Number(totals?.contractsNet ?? 0) / 1e6;
  const usdGross = Number(totals?.usdGross ?? 0) / 1e6;
  const usdNet = Number(totals?.usdNet ?? 0) / 1e6;
  const avgPrice = contractsGross > 0 ? usdGross / contractsGross : null;
  return {
    state,
    settlementStatus: execution?.settlementStatus,
    contracts: contractsNet,
    usd: usdNet,
    avgPrice,
    effectiveFeeBps: execution?.effectiveFeeBps,
    eligibleAt: execution?.eligibleAt,
    txHash: execution?.txHash,
    reason: (execution as { reason?: string } | undefined)?.reason,
  };
}
