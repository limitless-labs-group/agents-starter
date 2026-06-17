/**
 * StatusWriter — one always-current JSON snapshot of the run on disk.
 *
 * Subscribes to the Recorder event stream and atomically overwrites
 * `data/cross-market-mm-status.json` with the live state: mode, uptime, PnL,
 * equity, per-pair net delta, hedge count, last fill, and breaker/stop state.
 *
 * This is the machine-readable surface an orchestrating agent (e.g. a Telegram
 * agent running this as a skill) reads to report status or drive a heartbeat —
 * no bot token, no second channel, no polling the venues. Writes are atomic
 * (temp + rename) so a reader never catches a half-written file, and
 * best-effort: a write failure is swallowed and never affects the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TimestampedEvent } from './recorder.js';

export interface LiveStatus {
  updatedAt: number; // epoch ms of the last update
  startedAt: number;
  uptimeMs: number;
  mode: 'live' | 'dry';
  pairs: number;
  orderSize: number;
  breaker: { maxLossUsd: number; tripped: boolean };
  pnl: number | null;
  equity: number | null;
  hedges: number;
  skippedHedges: number;
  lastFill: { pair: string; buy: 'YES' | 'NO'; shares: number; usd: number; at: number } | null;
  lastHedgeSkip: { pair: string; reason: string; buy: 'YES' | 'NO'; shares: number; usd: number; net: number; at: number } | null;
  net: Array<{ pair: string; net: number }>;
  stopped: { reason: 'signal' | 'circuit-breaker'; flat: boolean | null; at: number } | null;
}

export interface StatusInit {
  mode: 'live' | 'dry';
  pairs: number;
  orderSize: number;
  maxLossUsd: number;
}

export class StatusWriter {
  readonly filePath: string;
  private readonly status: LiveStatus;
  private readonly netByPair = new Map<string, number>();

  constructor(init: StatusInit, dir: string = process.env.CROSS_MARKET_MM_DATA_DIR || process.env.REPLICATOR_DATA_DIR || './data') {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'cross-market-mm-status.json');
    const now = Date.now();
    this.status = {
      updatedAt: now,
      startedAt: now,
      uptimeMs: 0,
      mode: init.mode,
      pairs: init.pairs,
      orderSize: init.orderSize,
      breaker: { maxLossUsd: init.maxLossUsd, tripped: false },
      pnl: null,
      equity: null,
      hedges: 0,
      skippedHedges: 0,
      lastFill: null,
      lastHedgeSkip: null,
      net: [],
      stopped: null,
    };
    this.write();
  }

  /** Fold one event into the live snapshot and flush. Noisy/irrelevant kinds
   *  (`order`, `run`) don't change the summary and skip the write. */
  onEvent(ev: TimestampedEvent): void {
    switch (ev.kind) {
      case 'snapshot':
        this.netByPair.set(ev.pair, ev.net);
        break;
      case 'equity':
        this.status.pnl = ev.pnl;
        this.status.equity = ev.equity;
        break;
      case 'hedge':
        if (ev.success) {
          this.status.hedges += 1;
          this.status.lastFill = {
            pair: ev.pair,
            buy: ev.buy,
            shares: ev.shares,
            usd: ev.usdc,
            at: ev.t,
          };
        }
        break;
      case 'hedge_skip':
        this.status.skippedHedges += 1;
        this.status.lastHedgeSkip = {
          pair: ev.pair,
          reason: ev.reason,
          buy: ev.buy,
          shares: ev.shares,
          usd: ev.usdc,
          net: ev.net,
          at: ev.t,
        };
        break;
      default:
        return;
    }
    this.flush();
  }

  /** The breaker tripped — reflect it immediately (source of truth: run.ts onKill). */
  markTripped(): void {
    this.status.breaker.tripped = true;
    this.flush();
  }

  /** Final state on shutdown so a reader can tell the run ended (and whether flat). */
  markStopped(reason: 'signal' | 'circuit-breaker', flat: boolean | null): void {
    this.status.stopped = { reason, flat, at: Date.now() };
    this.flush();
  }

  private flush(): void {
    this.status.net = [...this.netByPair.entries()].map(([pair, net]) => ({ pair, net }));
    const now = Date.now();
    this.status.updatedAt = now;
    this.status.uptimeMs = now - this.status.startedAt;
    this.write();
  }

  private write(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.status, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // best-effort — never break the run on a status write
    }
  }
}
