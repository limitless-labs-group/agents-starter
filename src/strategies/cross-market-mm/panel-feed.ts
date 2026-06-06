/**
 * PanelWriter — emit the Trader Lab control panel's data contract.
 *
 * The Limitless Academy ships an operator panel (FastAPI + one HTML page) in
 * programs/limitless_trader_lab/bonus/CONTROL_PANEL.md. Rather than build a
 * second panel here, cross-market-mm just EMITS the three files that panel
 * reads, so the existing panel renders this bot unchanged:
 *
 *   positions.json  - array of {slug,title,side,shares,avg_price,mark}
 *   fills.ndjson    - append-only; one JSON/line. A row is a fill iff it has
 *                     numeric price+shares; everything else is an {event} row.
 *   kill.flag       - present == halted. The breaker writes it; the bot reads
 *                     it (panel kill button). One mechanism, two triggers.
 *
 * Point the panel at these via POSITIONS_PATH / AGENT_LOG / KILL_SWITCH.
 *
 * Mapping choices (honest, not decorative):
 *  - Only a successful HEDGE is a fill. Quote placements (`order`) are
 *    cancel-replace churn every tick, not fills, so they are NOT emitted.
 *  - A pair's row shows its cross-venue NET DELTA as the position: side =
 *    direction of net, shares = |net|. avg_price = mark = 0.5, so per-row P&L
 *    is 0 — we don't fabricate a cost basis. Flat pair => ~0 shares. This
 *    surfaces the delta-neutral story directly in the positions table.
 *  - The panel's P&L curve is mark-to-fill over the hedge fills; the dollar
 *    equity/PnL truth stays in status.json + breaker events.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ReplicatorEvent, TimestampedEvent } from './recorder.js';

type HedgeEvent = Extract<ReplicatorEvent, { kind: 'hedge' }>;

export interface PanelInit {
  mode: 'live' | 'dry';
  orderSize: number;
}

interface PanelPosition {
  slug: string;
  title: string;
  side: 'YES' | 'NO';
  shares: number;
  avg_price: number;
  mark: number;
}

export class PanelWriter {
  readonly dir: string;
  readonly positionsPath: string;
  readonly fillsPath: string;
  readonly killFlagPath: string;
  private readonly netByPair = new Map<string, number>();

  constructor(init: PanelInit, dir: string = process.env.REPLICATOR_DATA_DIR || './data') {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.positionsPath = path.join(dir, 'positions.json');
    this.fillsPath = path.join(dir, 'fills.ndjson');
    this.killFlagPath = path.join(dir, 'kill.flag');
    // Fresh display state per run (positions + fills). kill.flag is NOT cleared
    // here — a tripped breaker must stay tripped across restarts (see run.ts).
    this.writePositions();
    fs.writeFileSync(this.fillsPath, '');
    this.appendEvent('run', { mode: init.mode, order_size: init.orderSize });
  }

  /** Fold one recorder event into the panel files. */
  onEvent(ev: TimestampedEvent): void {
    switch (ev.kind) {
      case 'snapshot':
        this.netByPair.set(ev.pair, ev.net);
        this.writePositions();
        break;
      case 'hedge':
        if (ev.success) this.appendFill(ev);
        break;
      // 'order' is cancel-replace churn (not a fill); 'equity'/'run' carried
      // elsewhere. Nothing else lands in the fills feed by default.
    }
  }

  /** Breaker trip or manual halt — record it in the feed (panel shows it). */
  appendEvent(event: string, fields: Record<string, unknown> = {}): void {
    this.append({ ts: new Date().toISOString(), event, ...fields });
  }

  /** kill.flag helpers (the panel toggles the same file). */
  killFlagExists(): boolean {
    return fs.existsSync(this.killFlagPath);
  }
  writeKillFlag(reason: string): void {
    try {
      fs.writeFileSync(this.killFlagPath, `tripped: ${reason} at ${new Date().toISOString()}\n`);
    } catch {
      /* best-effort */
    }
  }

  // -- internals --

  private appendFill(ev: HedgeEvent): void {
    // Numeric price + shares => the panel renders this as a fill.
    this.append({
      ts: new Date().toISOString(),
      slug: ev.pair,
      side: ev.buy,
      shares: Number(ev.shares.toFixed(2)),
      price: Number(ev.price.toFixed(4)),
      usdc: Number(ev.usdc.toFixed(2)),
    });
  }

  private append(record: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.fillsPath, JSON.stringify(record) + '\n');
    } catch {
      /* best-effort side channel */
    }
  }

  private writePositions(): void {
    const rows: PanelPosition[] = [...this.netByPair.entries()].map(([pair, net]) => ({
      slug: pair,
      title: pair,
      side: net >= 0 ? 'YES' : 'NO',
      shares: Number(Math.abs(net).toFixed(2)),
      avg_price: 0.5, // neutral: we don't fabricate a cost basis (per-row P&L = 0)
      mark: 0.5,
    }));
    try {
      const tmp = `${this.positionsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
      fs.renameSync(tmp, this.positionsPath);
    } catch {
      /* best-effort */
    }
  }
}
