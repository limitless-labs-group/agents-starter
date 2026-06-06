/**
 * PanelWriter — emit the Academy control panel's data contract.
 *
 * The Limitless Academy ships an operator panel (FastAPI + one HTML page). The
 * Market Maker Bootcamp adds a market-maker variant of it
 * (Academy/programs/market_maker_bootcamp/panel/, spec in CONTROL_PANEL_DELTAS.md)
 * that reads five flat files. Rather than build a panel here, cross-market-mm
 * EMITS those files so the existing panel renders this bot unchanged:
 *
 *   quotes.json     - quote board: per-market two-sided quote, spread, inventory
 *   positions.json  - per-pair cross-venue net delta as positions
 *   fills.ndjson    - append-only; a row is a fill iff numeric price+shares
 *   kill.flag       - present == halted (breaker writes it; panel button toggles)
 *   pull.flag       - present == quotes pulled (cancel quotes, keep inventory)
 *
 * Point the panel at these via QUOTES_PATH / POSITIONS_PATH / AGENT_LOG /
 * KILL_SWITCH / PULL_SWITCH.
 *
 * Honest mappings (no fabricated data):
 *  - quote board: bid = our YES buy; ask = 1 - our NO buy (YES-frame); mid =
 *    fair_value = (bid+ask)/2, which equals the reference (poly) mid because the
 *    +-margin cancels. target_spread = 2 x margin. net_inventory = net delta.
 *  - positions: per-pair net delta (side = direction, shares = |net|); avg=mark
 *    so per-row P&L is 0 (no fabricated cost basis).
 *  - fills: only a successful HEDGE is a fill (quote cancel-replace churn is not).
 *    Hedges are Polymarket buys -> action BUY, liquidity taker (honest).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ReplicatorEvent, TimestampedEvent } from './recorder.js';

type HedgeEvent = Extract<ReplicatorEvent, { kind: 'hedge' }>;
type OrderEvent = Extract<ReplicatorEvent, { kind: 'order' }>;

export interface PanelInit {
  mode: 'live' | 'dry';
  orderSize: number;
  marginBps: number;
}

interface PanelPosition {
  slug: string;
  title: string;
  side: 'YES' | 'NO';
  shares: number;
  avg_price: number;
  mark: number;
}

interface Leg {
  price: number;
  shares: number;
  order_id?: string;
}

const r4 = (n: number): number => Number(n.toFixed(4));

export class PanelWriter {
  readonly dir: string;
  readonly quotesPath: string;
  readonly positionsPath: string;
  readonly fillsPath: string;
  readonly killFlagPath: string;
  readonly pullFlagPath: string;

  private readonly orderSize: number;
  private readonly targetSpread: number;
  private readonly netByPair = new Map<string, number>();
  private readonly yesOrderByPair = new Map<string, Leg>();
  private readonly noOrderByPair = new Map<string, Leg>();
  private stopped = false;

  constructor(init: PanelInit, dir: string = process.env.REPLICATOR_DATA_DIR || './data') {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.quotesPath = path.join(dir, 'quotes.json');
    this.positionsPath = path.join(dir, 'positions.json');
    this.fillsPath = path.join(dir, 'fills.ndjson');
    this.killFlagPath = path.join(dir, 'kill.flag');
    this.pullFlagPath = path.join(dir, 'pull.flag');
    this.orderSize = init.orderSize;
    this.targetSpread = r4((2 * init.marginBps) / 10_000);
    // Fresh display state per run (quotes/positions/fills). kill.flag is NOT
    // cleared here — a tripped breaker must stay tripped across restarts.
    this.writeQuotes();
    this.writePositions();
    fs.writeFileSync(this.fillsPath, '');
    this.appendEvent('run', { mode: init.mode, order_size: init.orderSize });
  }

  /** Fold one recorder event into the panel files. */
  onEvent(ev: TimestampedEvent): void {
    switch (ev.kind) {
      case 'order':
        this.trackOrder(ev);
        this.writeQuotes();
        break;
      case 'snapshot':
        this.netByPair.set(ev.pair, ev.net);
        this.writePositions();
        this.writeQuotes(); // refresh inventory + pull-state on every tick
        break;
      case 'hedge':
        if (ev.success) this.appendFill(ev);
        break;
      // 'equity'/'run' carried elsewhere; nothing else lands by default.
    }
  }

  /** Breaker trip or manual halt — record it in the feed (panel shows it). */
  appendEvent(event: string, fields: Record<string, unknown> = {}): void {
    this.append({ ts: new Date().toISOString(), event, ...fields });
  }

  /** Final state: mark every quote stopped so the panel shows the halt. */
  markStopped(): void {
    this.stopped = true;
    this.writeQuotes();
  }

  killFlagExists(): boolean {
    return fs.existsSync(this.killFlagPath);
  }
  pullFlagExists(): boolean {
    return fs.existsSync(this.pullFlagPath);
  }
  writeKillFlag(reason: string): void {
    try {
      fs.writeFileSync(this.killFlagPath, `tripped: ${reason} at ${new Date().toISOString()}\n`);
    } catch {
      /* best-effort */
    }
  }

  // -- internals --

  private trackOrder(ev: OrderEvent): void {
    const leg: Leg = { price: r4(ev.price), shares: ev.size, order_id: ev.orderId };
    if (ev.side === 'YES') this.yesOrderByPair.set(ev.pair, leg);
    else this.noOrderByPair.set(ev.pair, leg);
  }

  private appendFill(ev: HedgeEvent): void {
    // Numeric price + shares => the panel renders this as a fill. Hedges are
    // Polymarket buys: action BUY, liquidity taker (honest, not decorative).
    this.append({
      ts: new Date().toISOString(),
      slug: ev.pair,
      side: ev.buy,
      action: 'BUY',
      liquidity: 'taker',
      shares: Number(ev.shares.toFixed(2)),
      price: r4(ev.price),
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

  private writeQuotes(): void {
    const pulled = this.pullFlagExists();
    const slugs = new Set([...this.yesOrderByPair.keys(), ...this.noOrderByPair.keys(), ...this.netByPair.keys()]);
    const rows = [...slugs].map((slug) => {
      const yes = this.yesOrderByPair.get(slug); // YES buy = bid
      const no = this.noOrderByPair.get(slug); // NO buy => YES-frame ask at 1 - price
      const bid: Leg | null = yes ? { price: yes.price, shares: yes.shares, order_id: yes.order_id } : null;
      const ask: Leg | null = no ? { price: r4(1 - no.price), shares: no.shares, order_id: no.order_id } : null;
      const mid = bid && ask ? r4((bid.price + ask.price) / 2) : (bid?.price ?? ask?.price ?? null);
      const net = this.netByPair.get(slug) ?? 0;
      const state = this.stopped
        ? 'stopped'
        : pulled
          ? 'pulled'
          : bid && ask
            ? 'two_sided'
            : 'one_sided';
      return {
        slug,
        title: slug,
        outcome: 'YES',
        mid,
        fair_value: mid, // we quote symmetrically around the reference mid
        bid,
        ask,
        spread: bid && ask ? r4(ask.price - bid.price) : null,
        target_spread: this.targetSpread,
        net_inventory: Number(net.toFixed(2)),
        inventory_cap: this.orderSize,
        state,
        reason: null,
      };
    });
    this.atomicWrite(this.quotesPath, rows);
  }

  private writePositions(): void {
    const rows: PanelPosition[] = [...this.netByPair.entries()].map(([pair, net]) => ({
      slug: pair,
      title: pair,
      side: net >= 0 ? 'YES' : 'NO',
      shares: Number(Math.abs(net).toFixed(2)),
      avg_price: 0.5, // neutral: no fabricated cost basis (per-row P&L = 0)
      mark: 0.5,
    }));
    this.atomicWrite(this.positionsPath, rows);
  }

  private atomicWrite(file: string, data: unknown): void {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      /* best-effort */
    }
  }
}
