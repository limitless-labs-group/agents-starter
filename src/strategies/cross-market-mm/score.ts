/**
 * score — turn one recorded cross-market-mm run into a single comparable number
 * plus an experiment-ledger line. This is the metric the autonomous experiment
 * loop (see program.md) optimizes: higher = a cleaner, lower-bleed, better-hedged
 * run.
 *
 *   npm run cross-market-mm:score                       # latest run in ./data
 *   npm run cross-market-mm:score <file.jsonl>          # a specific run
 *   npm run cross-market-mm:score -- --interventions 2  # note manual rescues
 *
 * It reads the JSONL written by recorder.ts (the same source as analyze.ts),
 * computes the components below, prints the breakdown, and appends one line to
 * <dataDir>/experiments.ndjson so runs accumulate into a learning record.
 *
 * The score is a transparent weighted sum and the breakdown is always printed:
 * optimize the components, not a single Goodhartable number. A run that never
 * filled tested nothing, so it is marked INCONCLUSIVE (no score) rather than
 * rewarded for resting quotes that no one hit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimestampedEvent } from './recorder.js';

// Transparent, tunable weights. A "great" run (every fill hedged, mostly flat,
// some real fills, ~no bleed, low peak inventory, no manual rescue) lands ~80.
const WEIGHTS = {
  hedge: 40, // * hedge success rate (0..1)
  flat: 25, // * fraction of ticks delta-flat (0..1)
  fills: 15, // * min(fills, FILL_CAP) / FILL_CAP — reward activity, capped so churn doesn't win
  bleed: 5, // - per USD of realized loss
  inventory: 5, // - per order-size multiple of peak net exposure
  manual: 20, // - per operator-noted manual intervention
} as const;
const FILL_CAP = 10;
const FLAT_EPS = 1e-6;

type Logged = TimestampedEvent;

function latestFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('cross-market-mm-') && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
  if (files.length === 0) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

interface Components {
  hedgeRate: number;
  flatFrac: number;
  fills: number;
  bleedUsd: number;
  inventoryMult: number;
  interventions: number;
}

interface ScoreResult {
  file: string;
  ts: string;
  mode: 'DRY' | 'LIVE';
  pairs: number;
  orderSize: number;
  marginBps: number;
  durationSec: number;
  hedges: number;
  hedgeOk: number;
  components: Components;
  score: number | null;
  verdict: 'ok' | 'inconclusive';
  reason?: string;
}

/** Pure scoring over already-parsed events — the testable core. */
export function scoreEvents(events: Logged[], interventions: number, fileName: string): ScoreResult {
  const run = events.find((e) => e.kind === 'run') as (Logged & { kind: 'run' }) | undefined;
  const snaps = events.filter((e) => e.kind === 'snapshot') as Array<Logged & { kind: 'snapshot' }>;
  const hedges = events.filter((e) => e.kind === 'hedge') as Array<Logged & { kind: 'hedge' }>;
  const equities = events.filter((e) => e.kind === 'equity') as Array<Logged & { kind: 'equity' }>;

  const t0 = events.length ? events[0].t : Date.now();
  const t1 = events.length ? events[events.length - 1].t : t0;
  const orderSize = run?.orderSize ?? 0;

  // -- fills + flatness + peak inventory, derived exactly as analyze.ts does --
  let totalFills = 0;
  let flatTicks = 0;
  let maxInventory = 0;
  const pairs = [...new Set(snaps.map((s) => s.pair))];
  for (const pair of pairs) {
    const ps = snaps.filter((s) => s.pair === pair).sort((a, b) => a.t - b.t);
    for (let i = 0; i < ps.length; i++) {
      const s = ps[i];
      if (Math.abs(s.net) < FLAT_EPS) flatTicks++;
      maxInventory = Math.max(maxInventory, Math.abs(s.net));
      if (i > 0) {
        const dYes = s.lmtsYes - ps[i - 1].lmtsYes;
        const dNo = s.lmtsNo - ps[i - 1].lmtsNo;
        if (dYes > FLAT_EPS) totalFills += dYes;
        if (dNo > FLAT_EPS) totalFills += dNo;
      }
    }
  }

  const okHedges = hedges.filter((h) => h.success).length;
  const hedgeRate = hedges.length > 0 ? okHedges / hedges.length : 1;
  const flatFrac = snaps.length > 0 ? flatTicks / snaps.length : 0;
  const finalPnl = equities.length > 0 ? equities[equities.length - 1].pnl : null;
  const bleedUsd = finalPnl != null ? Math.max(0, -finalPnl) : 0;
  const inventoryMult = orderSize > 0 ? maxInventory / orderSize : maxInventory;

  const components: Components = {
    hedgeRate,
    flatFrac,
    fills: totalFills,
    bleedUsd,
    inventoryMult,
    interventions,
  };

  const base: Omit<ScoreResult, 'score' | 'verdict' | 'reason'> = {
    file: fileName,
    ts: new Date(t0).toISOString(),
    mode: run?.dryRun === false ? 'LIVE' : 'DRY',
    pairs: run?.pairs ?? pairs.length,
    orderSize,
    marginBps: run?.marginBps ?? 0,
    durationSec: Math.round((t1 - t0) / 1000),
    hedges: hedges.length,
    hedgeOk: okHedges,
    components,
  };

  // A run with no fills exercised nothing — don't let "resting quotes nobody hit"
  // score highly. Mark it inconclusive so the loop keeps searching.
  if (totalFills < 1) {
    return { ...base, score: null, verdict: 'inconclusive', reason: 'no fills — nothing tested' };
  }

  const score =
    WEIGHTS.hedge * hedgeRate +
    WEIGHTS.flat * flatFrac +
    WEIGHTS.fills * (Math.min(totalFills, FILL_CAP) / FILL_CAP) -
    WEIGHTS.bleed * bleedUsd -
    WEIGHTS.inventory * inventoryMult -
    WEIGHTS.manual * interventions;

  // Store full precision; round only for display.
  return { ...base, score, verdict: 'ok' };
}

/** Read a run JSONL and score it. */
function compute(file: string, interventions: number): ScoreResult {
  const events: Logged[] = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged);
  return scoreEvents(events, interventions, path.basename(file));
}

function ledgerPath(): string {
  const dir = process.env.CROSS_MARKET_MM_DATA_DIR || process.env.REPLICATOR_DATA_DIR || './data';
  return path.join(dir, 'experiments.ndjson');
}

function readLedger(): ScoreResult[] {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ScoreResult);
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function main(): void {
  const argv = process.argv.slice(2);
  let interventions = 0;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interventions') {
      interventions = Math.max(0, parseInt(argv[++i] ?? '0', 10) || 0);
    } else {
      positional.push(argv[i]);
    }
  }

  const file =
    positional[0] ||
    latestFile(process.env.CROSS_MARKET_MM_DATA_DIR || process.env.REPLICATOR_DATA_DIR || './data');
  if (!file || !fs.existsSync(file)) {
    console.error('No run data found. Run `npm run cross-market-mm` first (it writes ./data/*.jsonl).');
    process.exit(1);
  }

  const r = compute(file, interventions);
  const c = r.components;

  console.log(`\n=== Cross-market MM score: ${r.file} ===`);
  console.log(`mode: ${r.mode} | pairs: ${r.pairs} | order_size: ${r.orderSize} | margin_bps: ${r.marginBps} | ${r.durationSec}s`);
  console.log('\nComponents (the levers — tune these, not the total):');
  console.log(`  hedge success   ${fmt(c.hedgeRate * 100, 0)}%   (+${fmt(WEIGHTS.hedge * c.hedgeRate, 1)})   ${r.hedgeOk}/${r.hedges} hedges ok`);
  console.log(`  flatness        ${fmt(c.flatFrac * 100, 0)}%   (+${fmt(WEIGHTS.flat * c.flatFrac, 1)})   ticks delta-flat`);
  console.log(`  fills           ${fmt(c.fills, 1)}    (+${fmt(WEIGHTS.fills * (Math.min(c.fills, FILL_CAP) / FILL_CAP), 1)})   capped at ${FILL_CAP}`);
  console.log(`  bleed           $${fmt(c.bleedUsd)}  (-${fmt(WEIGHTS.bleed * c.bleedUsd, 1)})   realized loss`);
  console.log(`  inventory       ${fmt(c.inventoryMult, 2)}x  (-${fmt(WEIGHTS.inventory * c.inventoryMult, 1)})   peak net / order_size`);
  console.log(`  interventions   ${c.interventions}     (-${fmt(WEIGHTS.manual * c.interventions, 1)})   manual rescues`);

  if (r.verdict === 'inconclusive') {
    console.log(`\nVERDICT: INCONCLUSIVE — ${r.reason}. Try a more active market, tighter margin_bps, or a longer window.`);
  } else {
    console.log(`\nSCORE: ${r.score!.toFixed(1)}`);
  }

  // -- append to the experiment ledger (dedupe by run file) --
  const ledger = readLedger();
  if (ledger.some((e) => e.file === r.file)) {
    console.log(`\n(already in experiments.ndjson — not re-logged)`);
  } else {
    fs.appendFileSync(ledgerPath(), `${JSON.stringify(r)}\n`);
    const scored = ledger.filter((e) => typeof e.score === 'number') as Array<ScoreResult & { score: number }>;
    if (r.verdict === 'ok' && r.score != null) {
      const best = scored.reduce((m, e) => Math.max(m, e.score), -Infinity);
      if (scored.length === 0 || r.score > best) {
        console.log(`\nlogged to experiments.ndjson — NEW BEST (prev best ${scored.length ? best.toFixed(1) : 'none'})`);
      } else {
        console.log(`\nlogged to experiments.ndjson — score ${r.score.toFixed(1)} vs best ${best.toFixed(1)}`);
      }
    } else {
      console.log(`\nlogged to experiments.ndjson (inconclusive — kept for the record)`);
    }
  }
  console.log('');
}

// Only run as a CLI; importing for tests must not execute main().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
