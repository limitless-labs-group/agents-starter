/**
 * Risk monitor — the circuit breaker that makes unattended live running safe.
 *
 * Tracks mark-to-market equity across both venues and trips (→ cancel-all +
 * halt) when drawdown from the run's starting equity crosses a kill threshold.
 * Equity = free pUSD (Polymarket) + free USDC (Base) + Limitless collateral
 * locked in resting orders + marked value of open positions on both venues.
 * Including locked collateral keeps equity stable as the bot cancel-replaces
 * (resting orders aren't a loss); marks capture acquired positions.
 *
 * Resilient by design: a tick whose reads fail (RPC hiccup, etc.) yields a
 * null equity and is SKIPPED — the breaker never trips on missing/garbage data.
 */

import { pino } from 'pino';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'risk' });

// Native USDC on Base (6 decimals) — Limitless collateral.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export interface EquityInputs {
  pUSD: number; // Polymarket free collateral
  lmtsFreeUsd: number; // Base USDC free in the trading wallet
  lmtsLocked: number; // Limitless collateral reserved by resting orders
  posValue: number; // marked value of open positions (both venues)
}

export function totalEquity(e: EquityInputs): number {
  return e.pUSD + e.lmtsFreeUsd + e.lmtsLocked + e.posValue;
}

/**
 * Mark the value of one pair's positions. YES marked at the YES mid, NO at
 * (1 - YES mid). Works for both venues' share counts against the same fair mid.
 */
export function markPairValue(
  lmts: { yes: number; no: number },
  poly: { yes: number; no: number },
  yesMid: number | null,
): number {
  if (yesMid == null || !(yesMid > 0 && yesMid < 1)) {
    // No usable mark → value the shares at $0.50 (conservative, neutral).
    yesMid = 0.5;
  }
  const noMid = 1 - yesMid;
  return (
    (lmts.yes + poly.yes) * yesMid + (lmts.no + poly.no) * noMid
  );
}

/** Read free USDC (6dp) for an address on Base. Resilient: returns null on failure. */
export async function readBaseUsdc(
  address: string,
  rpcUrl: string = process.env.BASE_RPC_URL || 'https://mainnet.base.org',
): Promise<number | null> {
  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const bal = (await client.readContract({
      address: BASE_USDC as `0x${string}`,
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'a', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ],
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    })) as bigint;
    return Number(bal) / 1e6;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'base USDC read failed — skipping risk check this tick');
    return null;
  }
}

/**
 * Tracks equity vs a baseline captured on first valid update; trips when
 * drawdown crosses `killUsd`. Once tripped it stays tripped.
 */
export class RiskMonitor {
  private equity0: number | null = null;
  private tripped = false;

  constructor(private readonly killUsd: number) {}

  baseline(): number | null {
    return this.equity0;
  }
  isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Feed the latest equity (or null when reads failed → skip). Returns the
   * drawdown PnL and whether the breaker is now tripped.
   */
  update(equity: number | null): { pnl: number | null; equity: number | null; tripped: boolean } {
    // Guard against missing/garbage reads — never trip on bad data. Our real
    // equity is tens of dollars; <= 0 means the reads failed.
    if (equity == null || !Number.isFinite(equity) || equity <= 0) {
      return { pnl: null, equity: null, tripped: this.tripped };
    }
    if (this.equity0 == null) {
      this.equity0 = equity;
      logger.info({ equity0: equity.toFixed(2), killUsd: this.killUsd }, 'risk baseline set');
      return { pnl: 0, equity, tripped: false };
    }
    const pnl = equity - this.equity0;
    if (!this.tripped && pnl <= -this.killUsd) {
      this.tripped = true;
      logger.error(
        { pnl: pnl.toFixed(2), killUsd: this.killUsd, equity: equity.toFixed(2), equity0: this.equity0.toFixed(2) },
        'CIRCUIT BREAKER TRIPPED — halting + cancelling all',
      );
    }
    return { pnl, equity, tripped: this.tripped };
  }
}
