/**
 * Recorder — append-only JSONL data capture for a replicator run.
 *
 * Writes one JSON object per line to `data/replicator-<timestamp>.jsonl`
 * (override the dir with REPLICATOR_DATA_DIR). Every line is `{ t, kind, ... }`
 * where `t` is epoch ms. Cheap, structured, and trivially analyzable — see
 * `analyze.ts` (`npm run replicator:analyze`).
 *
 * What gets recorded:
 *   - `run`      once at boot (config + dryRun flag)
 *   - `order`    each Limitless BUY placed (side/price/size/id)
 *   - `snapshot` each hedger tick (per-pair net exposure + venue balances)
 *   - `hedge`    each Polymarket hedge attempt (side/shares/price/usdc/success)
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
      kind: 'equity';
      pnl: number;
      equity: number;
      pUSD: number;
      lmtsFreeUsd: number;
      lmtsLocked: number;
      posValue: number;
    };

export class Recorder {
  readonly filePath: string;
  private stream: fs.WriteStream | null;

  constructor(dir: string = process.env.REPLICATOR_DATA_DIR || './data') {
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `replicator-${ts}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  record(ev: ReplicatorEvent): void {
    if (!this.stream) return;
    this.stream.write(`${JSON.stringify({ t: Date.now(), ...ev })}\n`);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
