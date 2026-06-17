/**
 * Recorder — append-only JSONL data capture for a cross-market-mm run.
 *
 * Writes one JSON object per line to `data/cross-market-mm-<timestamp>.jsonl`
 * (override the dir with CROSS_MARKET_MM_DATA_DIR). Every line is `{ t, kind, ... }`
 * where `t` is epoch ms. Cheap, structured, and trivially analyzable — see
 * `analyze.ts` (`npm run cross-market-mm:analyze`).
 *
 * What gets recorded:
 *   - `run`      once at boot (config + dryRun flag)
 *   - `order`    each Limitless BUY placed (side/price/size/id)
 *   - `snapshot` each hedger tick (per-pair net exposure + venue balances)
 *   - `hedge`    each Polymarket hedge attempt (side/shares/price/usdc/success)
 *   - `hedge_skip` threshold-crossing exposure that could not be hedged yet
 *
 * Fills aren't logged explicitly — they're derived in `analyze.ts` from the
 * change in Limitless balances between consecutive snapshots.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ReplicatorEvent =
  | { kind: 'run'; dryRun: boolean; pairs: number; orderSize: number; marginBps: number }
  | { kind: 'order'; pair: string; side: 'YES' | 'NO'; price: number; size: number; orderId?: string }
  | {
      kind: 'snapshot';
      pair: string;
      net: number;
      lmtsYes: number;
      lmtsNo: number;
      polyYes: number;
      polyNo: number;
    }
  | {
      kind: 'hedge';
      pair: string;
      buy: 'YES' | 'NO';
      shares: number;
      price: number;
      usdc: number;
      success: boolean;
    }
  | {
      kind: 'hedge_skip';
      pair: string;
      reason: string;
      buy: 'YES' | 'NO';
      shares: number;
      price: number;
      usdc: number;
      net: number;
      threshold: number;
    }
  | {
      kind: 'equity';
      pnl: number;
      equity: number;
      pUSD: number;
      lmtsFreeUsd: number;
      posValue: number;
    };

/** An event with the epoch-ms timestamp the recorder stamps onto every line. */
export type TimestampedEvent = ReplicatorEvent & { t: number };

export class Recorder {
  readonly filePath: string;
  private stream: fs.WriteStream | null;
  private subscribers: ((ev: TimestampedEvent) => void)[] = [];

  constructor(dir: string = process.env.CROSS_MARKET_MM_DATA_DIR || process.env.REPLICATOR_DATA_DIR || './data') {
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `cross-market-mm-${ts}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    // The stream opens the fd asynchronously; a failed open/write (disk full,
    // dir removed) emits 'error'. Without a listener that's an uncaught
    // exception that would take down the bot — recording is best-effort, so
    // disable it instead of crashing.
    this.stream.on('error', () => {
      this.stream = null;
    });
  }

  /**
   * Subscribe to the event stream — every `record()` call fans out to each
   * subscriber (e.g. a Telegram broadcaster) in addition to the JSONL write.
   * Subscribers are best-effort and isolated: one throwing never breaks
   * recording or another subscriber. The JSONL file is always the source of
   * truth; subscribers are a live side-channel on top of it.
   */
  subscribe(fn: (ev: TimestampedEvent) => void): void {
    this.subscribers.push(fn);
  }

  record(ev: ReplicatorEvent): void {
    const stamped: TimestampedEvent = { t: Date.now(), ...ev };
    if (this.stream) {
      this.stream.write(`${JSON.stringify(stamped)}\n`);
    }
    for (const fn of this.subscribers) {
      try {
        fn(stamped);
      } catch {
        // best-effort side-channel — never let a subscriber break the run
      }
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
