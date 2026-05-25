/**
 * find-pairs — list candidate cross-venue market pairs for the replicator.
 *
 * Queries Limitless's active CLOB markets and Polymarket's active binary
 * markets, scores them by title-token Jaccard similarity, and prints the top
 * matches as paste-ready YAML for `replicator.config.yaml`.
 *
 * Usage:
 *   npm run replicator:find-pairs
 *
 * No auth required — both venues' active-market listings are public
 * (Limitless /markets/active and Polymarket's gamma-api).
 *
 * ⚠ Title similarity is a starting hint. The replicator only hedges
 * correctly when BOTH markets resolve on identical criteria — same asset,
 * same threshold, same time, same data source. Manually verify before
 * running live.
 */

import 'dotenv/config';
import { LimitlessClient } from '../../core/limitless/markets.js';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const TITLE_SIMILARITY_THRESHOLD = 0.4;
const TOP_N = 10;

// Generic prediction-market noise — drop before computing similarity so the
// signal-bearing tokens (asset names, numbers, dates) dominate the score.
const STOPWORDS = new Set([
  'will', 'be', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'by',
  'is', 'are', 'was', 'were', 'than', 'over', 'under', 'price', 'what',
  'when', 'reach', 'hit', 'above', 'below', 'before', 'after', 'this',
  'that', 'these', 'those', 'market', 'question', 'have', 'has', 'had',
  'do', 'does', 'did', 'with', 'and', 'or', 'not',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

interface PolyMarket {
  slug: string;
  question: string;
  eventSlug: string;
  eventTitle: string;
}

interface PolyEventApi {
  slug: string;
  title: string;
  markets?: Array<{
    slug: string;
    question: string;
    outcomes?: string;
    active?: boolean;
    archived?: boolean;
    closed?: boolean;
  }>;
}

async function fetchPolymarketMarkets(): Promise<PolyMarket[]> {
  // Gamma-api caps server-side at ~500 per page; we fetch a few pages to
  // cover the long tail of active events.
  const markets: PolyMarket[] = [];
  for (let offset = 0; offset < 1000; offset += 500) {
    const url = `${POLYMARKET_GAMMA_API}/events?active=true&closed=false&archived=false&limit=500&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Polymarket gamma-api ${res.status}: ${res.statusText}`);
    const events = (await res.json()) as PolyEventApi[];
    if (events.length === 0) break;
    for (const e of events) {
      for (const m of e.markets || []) {
        if (m.archived || m.closed || m.active === false) continue;
        let outcomes: string[] = [];
        try {
          outcomes = JSON.parse(m.outcomes || '[]');
        } catch {
          continue;
        }
        if (outcomes.length !== 2) continue;
        markets.push({
          slug: m.slug,
          question: m.question,
          eventSlug: e.slug,
          eventTitle: e.title,
        });
      }
    }
    if (events.length < 500) break;
  }
  return markets;
}

interface Candidate {
  lmtsSlug: string;
  lmtsTitle: string;
  polySlug: string;
  polyTitle: string;
  polyEventSlug: string;
  score: number;
}

async function main(): Promise<void> {
  console.log('Fetching active markets from both venues…');
  const limitless = new LimitlessClient();
  // Limitless API caps limit=25; paginate (page is 1-indexed).
  const lmtsMarkets = [];
  for (let page = 1; page <= 16; page++) {
    const chunk = await limitless.getActiveMarkets({ tradeType: 'clob', limit: 25, page });
    lmtsMarkets.push(...chunk);
    if (chunk.length < 25) break;
  }
  console.log(`  Limitless:  ${lmtsMarkets.length} active CLOB markets`);

  const polyMarkets = await fetchPolymarketMarkets();
  console.log(`  Polymarket: ${polyMarkets.length} active binary markets`);
  console.log();

  const polyTokens = polyMarkets.map((m) => ({ market: m, tokens: tokenize(m.question) }));

  const candidates: Candidate[] = [];
  for (const lmts of lmtsMarkets) {
    const lTokens = tokenize(lmts.title);
    if (lTokens.size === 0) continue;
    let best: { idx: number; score: number } | null = null;
    for (let i = 0; i < polyTokens.length; i++) {
      const s = jaccard(lTokens, polyTokens[i].tokens);
      if (!best || s > best.score) best = { idx: i, score: s };
    }
    if (best && best.score >= TITLE_SIMILARITY_THRESHOLD) {
      const p = polyTokens[best.idx].market;
      candidates.push({
        lmtsSlug: lmts.slug,
        lmtsTitle: lmts.title,
        polySlug: p.slug,
        polyTitle: p.question,
        polyEventSlug: p.eventSlug,
        score: best.score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    console.log('No candidate pairs found above the similarity threshold.');
    console.log(
      `  (threshold=${TITLE_SIMILARITY_THRESHOLD}; edit find-pairs.ts to lower it).`,
    );
    console.log('  This is common — venues frequently list different events.');
    console.log('  Browse https://app.limitless.exchange and https://polymarket.com');
    console.log('  to find genuinely-equivalent markets by hand.');
    return;
  }

  console.log(`Top ${Math.min(candidates.length, TOP_N)} candidate pairs:`);
  console.log();
  console.log('# ⚠  VERIFY both markets resolve on the SAME criteria before going live.');
  console.log('# Same asset, same threshold, same UTC moment, same data source.');
  console.log('# Title similarity is a hint, not a guarantee of identical resolution.');
  console.log('#');
  console.log('# Paste your chosen pair under `market_pairs:` in ./replicator.config.yaml');
  console.log();

  for (const c of candidates.slice(0, TOP_N)) {
    console.log(`# ── score=${c.score.toFixed(2)} ──────────────────`);
    console.log(`# Limitless:  ${c.lmtsTitle}`);
    console.log(`# Polymarket: ${c.polyTitle}`);
    console.log(`#   (poly event: ${c.polyEventSlug})`);
    console.log(`- polymarket_slug: "${c.polySlug}"`);
    console.log(`  limitless_slug:  "${c.lmtsSlug}"`);
    console.log();
  }
}

main().catch((e: any) => {
  console.error('find-pairs failed:', e?.message || e);
  process.exit(1);
});
