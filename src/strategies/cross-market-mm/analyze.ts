/**
 * analyze — summarize a recorded cross-market-mm run.
 *
 *   npm run cross-market-mm:analyze            # latest file in ./data
 *   npm run cross-market-mm:analyze <file>     # a specific JSONL
 *
 * Reads the JSONL written by recorder.ts and prints: run config, duration,
 * orders placed, fills inferred from Limitless balance deltas between
 * snapshots, hedges, and how flat the book stayed (the key health signal).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ReplicatorEvent } from './recorder.js';

type Logged = ReplicatorEvent & { t: number };

function latestFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('cross-market-mm-') && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
  if (files.length === 0) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function main(): void {
  const arg = process.argv[2];
  const file = arg || latestFile(process.env.CROSS_MARKET_MM_DATA_DIR || process.env.REPLICATOR_DATA_DIR || './data');
  if (!file || !fs.existsSync(file)) {
    console.error('No run data found. Run `npm run cross-market-mm` first (it writes ./data/*.jsonl).');
    process.exit(1);
  }

  const events: Logged[] = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged);

  if (events.length === 0) {
    console.log(`${file}: empty.`);
    return;
  }

  const run = events.find((e) => e.kind === 'run') as (Logged & { kind: 'run' }) | undefined;
  const t0 = events[0].t;
  const t1 = events[events.length - 1].t;

  const orders = events.filter((e) => e.kind === 'order') as Array<Logged & { kind: 'order' }>;
  const snaps = events.filter((e) => e.kind === 'snapshot') as Array<Logged & { kind: 'snapshot' }>;
  const hedges = events.filter((e) => e.kind === 'hedge') as Array<Logged & { kind: 'hedge' }>;
  const hedgeSkips = events.filter((e) => e.kind === 'hedge_skip') as Array<Logged & { kind: 'hedge_skip' }>;
  const equities = events.filter((e) => e.kind === 'equity') as Array<Logged & { kind: 'equity' }>;

  console.log(`\n=== Cross-market MM run: ${path.basename(file)} ===`);
  if (run) {
    console.log(
      `mode: ${run.dryRun ? 'DRY_RUN' : 'LIVE'} | pairs: ${run.pairs} | order_size: ${run.orderSize} | margin_bps: ${run.marginBps}`,
    );
  }
  console.log(`duration: ${fmtDuration(t1 - t0)} | events: ${events.length}`);

  // -- Orders --
  const yesOrders = orders.filter((o) => o.side === 'YES').length;
  const noOrders = orders.filter((o) => o.side === 'NO').length;
  console.log(`\nOrders placed: ${orders.length}  (YES ${yesOrders} / NO ${noOrders})`);

  // -- Per-pair: fills (from Limitless balance deltas) + flatness --
  const pairs = [...new Set(snaps.map((s) => s.pair))];
  for (const pair of pairs) {
    const ps = snaps.filter((s) => s.pair === pair).sort((a, b) => a.t - b.t);
    let yesFilled = 0;
    let noFilled = 0;
    let flatTicks = 0;
    let maxAbsNet = 0;
    let sumAbsNet = 0;
    for (let i = 0; i < ps.length; i++) {
      const s = ps[i];
      if (Math.abs(s.net) < 1e-6) flatTicks++;
      maxAbsNet = Math.max(maxAbsNet, Math.abs(s.net));
      sumAbsNet += Math.abs(s.net);
      if (i > 0) {
        const dYes = s.lmtsYes - ps[i - 1].lmtsYes;
        const dNo = s.lmtsNo - ps[i - 1].lmtsNo;
        if (dYes > 1e-6) yesFilled += dYes;
        if (dNo > 1e-6) noFilled += dNo;
      }
    }
    const flatPct = ps.length ? ((flatTicks / ps.length) * 100).toFixed(0) : '0';
    console.log(`\nPair ${pair}`);
    console.log(`  snapshots: ${ps.length} | flat ${flatPct}% of ticks`);
    console.log(`  Limitless fills (Δbalance): YES +${yesFilled.toFixed(2)} / NO +${noFilled.toFixed(2)}`);
    console.log(`  net exposure: max |${maxAbsNet.toFixed(2)}| | avg |${(sumAbsNet / (ps.length || 1)).toFixed(2)}|`);
  }

  // -- Hedges --
  const okHedges = hedges.filter((h) => h.success);
  const hedgedUsdc = okHedges.reduce((a, h) => a + h.usdc, 0);
  console.log(
    `\nHedges: ${hedges.length} fired (${okHedges.length} ok) | $${hedgedUsdc.toFixed(2)} bought on Polymarket`,
  );
  if (hedgeSkips.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of hedgeSkips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    const reasons = [...byReason.entries()].map(([reason, n]) => `${reason}: ${n}`).join(', ');
    const last = hedgeSkips[hedgeSkips.length - 1];
    console.log(`Hedge skips: ${hedgeSkips.length} (${reasons})`);
    console.log(
      `  last skip: ${last.pair} | ${last.reason} | net ${last.net.toFixed(2)} | ` +
        `would buy ${last.shares.toFixed(2)} ${last.buy} for $${last.usdc.toFixed(2)}`,
    );
  }

  // -- PnL / equity (the "is it bleeding?" signal) --
  if (equities.length > 0) {
    const pnls = equities.map((e) => e.pnl);
    const minPnl = Math.min(...pnls);
    const maxPnl = Math.max(...pnls);
    const last = equities[equities.length - 1];
    console.log(
      `\nEquity (live): start $${equities[0].equity.toFixed(2)} → end $${last.equity.toFixed(2)} | ` +
        `net PnL $${last.pnl.toFixed(2)} | worst $${minPnl.toFixed(2)} | best $${maxPnl.toFixed(2)}`,
    );
  }

  if (orders.length > 0 && snaps.every((s) => Math.abs(s.net) < 1e-6) && hedges.length === 0) {
    console.log(`\nNote: quotes rested but nothing filled (book stayed flat). Try a more active`);
    console.log(`market, tighter margin_bps, or a longer run to exercise fills + the hedge path.`);
  }
  console.log('');
}

main();
