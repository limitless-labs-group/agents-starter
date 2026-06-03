/**
 * find-pairs — shortlist liquid cross-venue market pairs for the cross-market-mm.
 *
 * Queries Limitless's active CLOB markets and Polymarket's active binary
 * markets, matches them by title-token similarity, then **filters and ranks
 * by liquidity** so you don't end up quoting inside a thin, skewed book (no
 * fills, lopsided capital). Prints a shortlist as paste-ready YAML.
 *
 * "Not thin" here means: Polymarket has a live orderbook with a tight spread
 * and a balanced price (so both YES/NO legs are reasonably sized), and the
 * Limitless market has some traded volume (so your resting quotes can fill).
 *
 * Usage:
 *   npm run cross-market-mm:find-pairs
 *
 * No auth required — both venues' active-market listings are public
 * (Limitless /markets/active and Polymarket's gamma-api).
 *
 * ⚠ Title similarity is a starting hint. The cross-market-mm only hedges
 * correctly when BOTH markets resolve on identical criteria — same asset,
 * same threshold, same time, same data source. Manually verify before
 * running live.
 */

import 'dotenv/config';
import { LimitlessClient } from '../../core/limitless/markets.js';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const TITLE_SIMILARITY_THRESHOLD = 0.4;
const TOP_N = 10;

// Liquidity gates (tune to taste). A candidate must clear all of these to be
// considered "tradeable" rather than thin.
const MIN_POLY_LIQUIDITY = 1000; // USD resting in the Polymarket CLOB book
const MAX_POLY_SPREAD = 0.05; // max bid/ask gap we'll quote inside (5 cents)
const PRICE_MIN = 0.1; // avoid extreme/skewed books (e.g. 7% longshots)
const PRICE_MAX = 0.9; //   where one leg locks ~all the capital
const MIN_LMTS_VOLUME = 100; // some traded volume on the Limitless side

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

// Negation/direction words are STOPWORDS (stripped before similarity), so
// "OpenAI IPO by Dec 31" and "OpenAI will NOT IPO by Dec 31" tokenize
// identically and score ~1.0 — yet they resolve OPPOSITE. Quoting a
// polarity-flipped pair is catastrophic: the "hedge" doubles your exposure
// instead of offsetting it. So check raw titles for a polarity mismatch the
// token similarity can't see, and flag it loudly.
const NEGATIONS = ["not", "no", "won't", "wont", "isn't", "isnt", "doesn't", "doesnt", "never", "without", "fail", "fails"];
const DIRECTIONS: Array<[string, string]> = [
  ['above', 'below'],
  ['over', 'under'],
  ['higher', 'lower'],
  ['more', 'less'],
  ['up', 'down'],
  ['greater', 'fewer'],
];

function hasWord(title: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/'/g, "'?")}\\b`, 'i').test(title);
}

/** Returns a reason string if the two titles look polarity-flipped, else null. */
export function polarityRisk(a: string, b: string): string | null {
  const aNeg = NEGATIONS.some((w) => hasWord(a, w));
  const bNeg = NEGATIONS.some((w) => hasWord(b, w));
  if (aNeg !== bNeg) return 'negation mismatch (one side says "not"/"no")';
  for (const [lo, hi] of DIRECTIONS) {
    const aDir = hasWord(a, lo) ? lo : hasWord(a, hi) ? hi : null;
    const bDir = hasWord(b, lo) ? lo : hasWord(b, hi) ? hi : null;
    if (aDir && bDir && aDir !== bDir) return `direction mismatch ("${aDir}" vs "${bDir}")`;
  }
  return null;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

interface PolyMarket {
  slug: string;
  question: string;
  eventSlug: string;
  eventTitle: string;
  liquidity: number;
  volume24hr: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  enableOrderBook: boolean;
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
    liquidity?: string | number;
    volume24hr?: string | number;
    spread?: string | number;
    bestBid?: string | number;
    bestAsk?: string | number;
    enableOrderBook?: boolean;
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
          outcomes = JSON.parse((m.outcomes as string) || '[]');
        } catch {
          continue;
        }
        if (outcomes.length !== 2) continue;
        markets.push({
          slug: m.slug,
          question: m.question,
          eventSlug: e.slug,
          eventTitle: e.title,
          liquidity: num(m.liquidity),
          volume24hr: num(m.volume24hr),
          spread: num(m.spread),
          bestBid: num(m.bestBid),
          bestAsk: num(m.bestAsk),
          enableOrderBook: m.enableOrderBook !== false,
        });
      }
    }
    if (events.length < 500) break;
  }
  return markets;
}

/**
 * Enumerate Limitless grouped/negRisk markets (tradeType=group) and flatten
 * each into its per-candidate sub-markets. These are the winner markets
 * (e.g. "UEFA Champions League Winner" → Arsenal/PSG/…) and head-to-heads
 * that the `clob` (marketType=single) listing omits — and they're exactly
 * the deepest cross-venue overlap (sports finals, elections, tournament
 * winners). Each sub-market has its own slug + tokens, so it's a quotable
 * binary. The candidate title is "<group> <candidate>" so title-similarity
 * matches Polymarket's "Will <candidate> win the <group>" phrasing.
 */
async function fetchLimitlessGroupSubMarkets(
  limitless: LimitlessClient,
): Promise<Array<{ title: string; slug: string; volumeFormatted?: string }>> {
  const out: Array<{ title: string; slug: string; volumeFormatted?: string }> = [];
  for (let page = 1; page <= 16; page++) {
    const groups = await limitless.getActiveMarkets({ tradeType: 'group', limit: 25, page });
    for (const g of groups as unknown as Array<Record<string, unknown>>) {
      const subs = (g.markets ?? g.outcomeTokens ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(subs)) continue;
      for (const s of subs) {
        const slug = s.slug as string | undefined;
        if (!slug) continue; // not independently quotable
        const candidate = (s.groupItemTitle ?? s.title ?? '') as string;
        out.push({
          // group volume is the best activity signal we have per sub-market
          title: `${g.title ?? ''} ${candidate}`.trim(),
          slug,
          volumeFormatted: (g.volumeFormatted ?? s.volumeFormatted) as string | undefined,
        });
      }
    }
    if (groups.length < 25) break;
  }
  return out;
}

interface Candidate {
  lmtsSlug: string;
  lmtsTitle: string;
  lmtsVolume: number;
  polySlug: string;
  polyTitle: string;
  polyEventSlug: string;
  score: number;
  poly: PolyMarket;
}

/** Does the Polymarket book clear the liquidity gates? */
function isLiquid(c: Candidate): boolean {
  const mid = (c.poly.bestBid + c.poly.bestAsk) / 2;
  return (
    c.poly.enableOrderBook &&
    c.poly.liquidity >= MIN_POLY_LIQUIDITY &&
    c.poly.spread > 0 &&
    c.poly.spread <= MAX_POLY_SPREAD &&
    mid >= PRICE_MIN &&
    mid <= PRICE_MAX &&
    c.lmtsVolume >= MIN_LMTS_VOLUME
  );
}

/** Structured form of a candidate for `--json` (an agent picks from these). */
function candidateJson(c: Candidate): Record<string, unknown> {
  return {
    polymarket_slug: c.polySlug,
    limitless_slug: c.lmtsSlug,
    score: Number(c.score.toFixed(3)),
    liquid: isLiquid(c),
    polarityRisk: polarityRisk(c.lmtsTitle, c.polyTitle), // null when aligned
    limitlessTitle: c.lmtsTitle,
    polymarketTitle: c.polyTitle,
    limitlessVolume: c.lmtsVolume,
    poly: {
      liquidity: c.poly.liquidity,
      volume24hr: c.poly.volume24hr,
      spread: c.poly.spread,
      bestBid: c.poly.bestBid,
      bestAsk: c.poly.bestAsk,
      mid: Number(((c.poly.bestBid + c.poly.bestAsk) / 2).toFixed(4)),
    },
  };
}

function printCandidate(c: Candidate): void {
  const mid = ((c.poly.bestBid + c.poly.bestAsk) / 2).toFixed(2);
  const polarity = polarityRisk(c.lmtsTitle, c.polyTitle);
  console.log(`# ── sim=${c.score.toFixed(2)} ────────────────────────────────`);
  if (polarity) {
    console.log(`# 🛑 POLARITY RISK: ${polarity} — these may resolve OPPOSITE.`);
    console.log(`#    Do NOT use this pair unless you confirm both resolve the SAME way.`);
  }
  console.log(`# Limitless:  ${c.lmtsTitle}  (vol ${c.lmtsVolume.toFixed(0)})`);
  console.log(`# Polymarket: ${c.polyTitle}`);
  console.log(
    `#   poly: liq $${c.poly.liquidity.toFixed(0)} | 24h vol $${c.poly.volume24hr.toFixed(0)} | ` +
      `spread ${c.poly.spread.toFixed(3)} | bid/ask ${c.poly.bestBid}/${c.poly.bestAsk} | mid ${mid}`,
  );
  console.log(`- polymarket_slug: "${c.polySlug}"`);
  console.log(`  limitless_slug:  "${c.lmtsSlug}"`);
  console.log();
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  // Progress/diagnostics go to stderr so `--json` stdout is pure JSON.
  const progress = (msg = ''): void => {
    if (asJson) console.error(msg);
    else console.log(msg);
  };
  progress('Fetching active markets from both venues…');
  const limitless = new LimitlessClient();
  // Limitless API caps limit=25; paginate (page is 1-indexed).
  const lmtsMarkets: Array<{ title: string; slug: string; volumeFormatted?: string }> = [];
  for (let page = 1; page <= 16; page++) {
    const chunk = await limitless.getActiveMarkets({ tradeType: 'clob', limit: 25, page });
    lmtsMarkets.push(...(chunk as typeof lmtsMarkets));
    if (chunk.length < 25) break;
  }
  const singleCount = lmtsMarkets.length;
  // Also enumerate grouped/negRisk sub-markets (winner markets, head-to-heads)
  // — the deepest cross-venue overlap, which the `clob` listing omits.
  const groupSubs = await fetchLimitlessGroupSubMarkets(limitless);
  lmtsMarkets.push(...groupSubs);
  progress(
    `  Limitless:  ${lmtsMarkets.length} markets (${singleCount} single + ${groupSubs.length} grouped sub-markets)`,
  );

  const polyMarkets = await fetchPolymarketMarkets();
  progress(`  Polymarket: ${polyMarkets.length} active binary markets`);
  progress();

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
        lmtsVolume: num((lmts as { volumeFormatted?: string }).volumeFormatted),
        polySlug: p.slug,
        polyTitle: p.question,
        polyEventSlug: p.eventSlug,
        score: best.score,
        poly: p,
      });
    }
  }

  if (candidates.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ liquid: [], thin: [] }, null, 2));
      return;
    }
    console.log('No title matches found above the similarity threshold.');
    console.log(`  (threshold=${TITLE_SIMILARITY_THRESHOLD}; venues often list different events.)`);
    return;
  }

  // Rank liquid candidates by title similarity first (a high score is the
  // best proxy we have for "actually the same market"), then by Polymarket
  // book liquidity as a tiebreak. Ranking by liquidity alone floats up
  // high-volume *false* matches (shared words, different questions). Fall
  // back to listing thin matches so the run isn't empty-handed.
  const byMatchThenLiquidity = (a: Candidate, b: Candidate) =>
    b.score - a.score || b.poly.liquidity - a.poly.liquidity;
  const liquid = candidates.filter(isLiquid).sort(byMatchThenLiquidity);
  const thin = candidates.filter((c) => !isLiquid(c)).sort((a, b) => b.score - a.score);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          liquid: liquid.slice(0, TOP_N).map(candidateJson),
          thin: thin.slice(0, TOP_N).map(candidateJson),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('# ⚠  VERIFY both markets resolve on the SAME criteria before going live.');
  console.log('# Same asset, same threshold, same UTC moment, same data source.');
  console.log('# Title similarity is a hint, not a guarantee of identical resolution.');
  console.log('#');
  console.log('# Paste your chosen pair under `market_pairs:` in ./cross-market-mm.config.yaml');
  console.log();

  if (liquid.length > 0) {
    console.log(
      `## ${Math.min(liquid.length, TOP_N)} LIQUID pair(s) ` +
        `(poly liq ≥ $${MIN_POLY_LIQUIDITY}, spread ≤ ${MAX_POLY_SPREAD}, ` +
        `price ${PRICE_MIN}-${PRICE_MAX}, lmts vol ≥ ${MIN_LMTS_VOLUME}):`,
    );
    console.log();
    for (const c of liquid.slice(0, TOP_N)) printCandidate(c);
  } else {
    console.log('## No pairs cleared the liquidity gates.');
    console.log('#  Loosen the thresholds at the top of find-pairs.ts, or pick from the');
    console.log('#  thin matches below (expect few/no fills + asymmetric capital).');
    console.log();
  }

  if (liquid.length < TOP_N && thin.length > 0) {
    console.log(`## ${Math.min(thin.length, TOP_N - liquid.length)} thinner title-match(es) (use with caution):`);
    console.log();
    for (const c of thin.slice(0, TOP_N - liquid.length)) printCandidate(c);
  }
}

main().catch((e: unknown) => {
  console.error('find-pairs failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
