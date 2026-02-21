/**
 * dashboard.ts — Limitless Agent Analytics Dashboard
 *
 * Serves a local web dashboard on http://localhost:3456 with:
 *   • Hero KPIs (balance, P&L, win rate, open positions, claimable)
 *   • SVG cumulative P&L chart
 *   • Open positions, open orders, trade history, claimable winnings
 *   • Server-Sent Events (SSE) for live dot + triggered refreshes
 *
 * Usage:
 *   npm run dashboard
 *   → open http://localhost:3456
 *
 * Requirements: PRIVATE_KEY + LIMITLESS_API_KEY in .env
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LimitlessClient } from './core/limitless/markets.js';
import { PortfolioClient } from './core/limitless/portfolio.js';
import { RedeemClient }    from './core/limitless/redeem.js';
import { TradingClient }   from './core/limitless/trading.js';
import { OrderSigner }     from './core/limitless/sign.js';
import { getWallet }       from './core/wallet.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3456', 10);

const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const HTML_FILE  = join(PUBLIC_DIR, 'dashboard.html');

// ── SDK clients ───────────────────────────────────────────────────────────────

const limitless = new LimitlessClient();
const portfolio = new PortfolioClient();

let redeemer: RedeemClient | null = null;
let trading:  TradingClient | null = null;
let walletAddress = '';

try {
    const { client: walletClient, account } = getWallet();
    walletAddress = account.address;
    const signer = new OrderSigner(walletClient, account);
    trading  = new TradingClient(limitless, signer);
    redeemer = new RedeemClient();
} catch {
    console.warn('⚠  PRIVATE_KEY not set — trading/claiming features disabled.');
}

// ── SSE broadcast infrastructure ──────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function sseWrite(data: object) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(payload);
        } catch {
            sseClients.delete(res);
        }
    }
}

// Send a heartbeat every 15 s so the client's SSE connection stays alive
// and the dot stays green.
setInterval(() => sseWrite({ type: 'heartbeat', ts: Date.now() }), 15_000);

// Broadcast an 'update' event every 30 s so all connected tabs refresh together.
setInterval(() => sseWrite({ type: 'update', ts: Date.now() }), 30_000);

// ── Data helpers ──────────────────────────────────────────────────────────────

/**
 * Build cumulative P&L data points from an array of raw chart points
 * returned by the Limitless API, or synthesise them from trade history
 * if the chart endpoint doesn't return time-series data.
 */
function buildCumPnl(
    chartData: any,
    trades: any[],
): { ts: string; pnl: number }[] {
    // Try chart API data first (array of {time|ts, value|pnl})
    if (Array.isArray(chartData?.data) && chartData.data.length > 0) {
        let running = 0;
        return chartData.data.map((pt: any) => {
            const v = parseFloat(pt.value ?? pt.pnl ?? pt.y ?? '0') || 0;
            running += v;
            return { ts: pt.time ?? pt.ts ?? '', pnl: Math.round(running * 100) / 100 };
        });
    }

    // Fallback: synthesise from trade history using sell amounts as P&L deltas.
    // This is a rough approximation but gives a meaningful chart shape.
    const sells = trades
        .filter(t => t.strategy === 'Sell')
        .sort((a, b) => {
            const ta = a.timestamp ?? a.createdAt ?? '';
            const tb = b.timestamp ?? b.createdAt ?? '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

    if (!sells.length) return [];

    let running = 0;
    return sells.map(t => {
        const amt = parseFloat(t.tradeAmountUSD ?? t.tradeAmount ?? '0') || 0;
        running += amt;
        return { ts: t.timestamp ?? '', pnl: Math.round(running * 100) / 100 };
    });
}

/**
 * Compute per-market asset breakdown from trade history for the bar charts.
 * Groups by market title, counting buys as "pending" and sells as resolved.
 */
function buildByAsset(trades: any[]): Record<string, { wins: number; losses: number; pending: number; pnl: number }> {
    const map: Record<string, { wins: number; losses: number; pending: number; pnl: number }> = {};

    for (const t of trades) {
        const key = t.marketTitle || t.market?.title || t.marketId || 'Unknown';
        if (!map[key]) map[key] = { wins: 0, losses: 0, pending: 0, pnl: 0 };
        const a = map[key];
        const amt = parseFloat(t.tradeAmountUSD ?? t.tradeAmount ?? '0') || 0;
        if (t.strategy === 'Sell') {
            if (amt > 0) { a.wins++; a.pnl += amt; }
            else        { a.losses++; a.pnl += amt; }
        } else {
            a.pending++;
        }
        a.pnl = Math.round(a.pnl * 100) / 100;
    }

    return map;
}

// ── Main data aggregation ─────────────────────────────────────────────────────

async function fetchDashboardData(): Promise<object> {
    const results: Record<string, any> = {
        wallet:    walletAddress || null,
        balance:   null,
        totalPnl:  0,
        winRate:   null,
        cumPnl:    [],
        byAsset:   {},
        positions: [],
        orders:    [],
        trades:    [],
        claimable: [],
        overview:  {},
    };

    // ── Positions ────────────────────────────────────────────────────────────
    try {
        const raw = await portfolio.getPositions();
        const positions: any[] = Array.isArray(raw)
            ? raw
            : [
                ...((raw as any).clob  ?? []),
                ...((raw as any).amm   ?? []),
                ...((raw as any).group ?? []),
              ];

        results.positions = positions.map((p: any) => {
            const hasYes = p.positions?.yes || p.yes;
            const hasNo  = p.positions?.no  || p.no;
            const side   = hasYes ? 'YES' : hasNo ? 'NO' : null;
            const sideData = side === 'YES'
                ? (p.positions?.yes ?? p.yes)
                : (p.positions?.no  ?? p.no);

            const fillPrice    = sideData?.fillPrice    ?? null;
            const currentPrice = sideData?.currentPrice ?? fillPrice;

            return {
                marketTitle:   p.market?.title   ?? p.marketTitle ?? 'Unknown',
                marketSlug:    p.market?.slug     ?? p.marketSlug  ?? '',
                side,
                size:          sideData?.marketValue  ?? null,
                fillPrice,
                currentPrice,
                unrealizedPnl: sideData?.unrealizedPnl ?? null,
            };
        });
    } catch (e: any) {
        console.error('[dashboard] positions error:', e.message);
    }

    // ── Trade history ────────────────────────────────────────────────────────
    try {
        const trades = await portfolio.getTrades();
        results.trades = Array.isArray(trades) ? trades : [];
    } catch (e: any) {
        console.error('[dashboard] trades error:', e.message);
    }

    // ── PnL chart (total P&L + win rate + optional time-series) ─────────────
    let chartRaw: any = null;
    try {
        chartRaw = await portfolio.getPnlChart('all');
        if (chartRaw?.totalPnl != null) {
            results.totalPnl = parseFloat(chartRaw.totalPnl) || 0;
        }
        if (chartRaw?.winRate != null) {
            // API may return 0-1 or 0-100 range
            const wr = parseFloat(chartRaw.winRate);
            results.winRate = wr <= 1 ? wr * 100 : wr;
        }
    } catch {
        // Non-critical; derive below
    }

    // Build cumulative P&L data for chart
    results.cumPnl = buildCumPnl(chartRaw, results.trades);

    // Derive win rate from trades if not provided by API
    if (results.winRate === null) {
        const sells  = (results.trades as any[]).filter(t => t.strategy === 'Sell');
        const wins   = sells.filter(t => (parseFloat(t.tradeAmountUSD ?? t.tradeAmount ?? '0') || 0) > 0).length;
        results.winRate = sells.length ? Math.round((wins / sells.length) * 1000) / 10 : null;
    }

    // Per-asset breakdown
    results.byAsset = buildByAsset(results.trades);

    // ── Open orders (from each known market slug) ────────────────────────────
    const knownSlugs = results.positions.map((p: any) => p.marketSlug).filter(Boolean);
    const openOrders: any[] = [];

    if (trading && knownSlugs.length > 0) {
        await Promise.all(
            knownSlugs.map(async (slug: string) => {
                try {
                    const orders = await trading!.getUserOrders(slug, 'OPEN');
                    const mapped = (Array.isArray(orders) ? orders : []).map((o: any) => ({
                        marketSlug:  slug,
                        marketTitle: results.positions.find((p: any) => p.marketSlug === slug)?.marketTitle ?? slug,
                        side:        o.side || o.outcome || '—',
                        price:       o.price  ?? null,
                        size:        o.size   ?? o.makerAmount ?? null,
                        status:      o.status ?? 'LIVE',
                        timestamp:   o.createdAt ?? o.timestamp ?? null,
                    }));
                    openOrders.push(...mapped);
                } catch { /* skip */ }
            })
        );
    }
    results.orders = openOrders;

    // ── Claimable winnings ───────────────────────────────────────────────────
    if (redeemer && results.positions.length > 0) {
        try {
            const slugs = [...new Set(results.positions.map((p: any) => p.marketSlug).filter(Boolean))] as string[];
            results.claimable = await redeemer.findClaimablePositions(slugs);
        } catch (e: any) {
            console.error('[dashboard] claimable error:', e.message);
        }
    }

    // ── Balance (derive from position size sum; actual USDC balance needs a
    //    chain call which we omit to avoid viem dependency in the dashboard) ──
    // Use totalPnl for context; balance left as null until a chain client is added.
    const positionValue = results.positions.reduce((s: number, p: any) => {
        return s + (parseFloat(p.size ?? '0') || 0);
    }, 0);
    results.balance = Math.round(positionValue * 100) / 100;

    // ── Consolidated overview block (mirrors old shape for compat) ───────────
    results.overview = {
        wallet:         walletAddress || null,
        balance:        results.balance,
        pnl:            results.totalPnl,
        winRate:        results.winRate,
        positionCount:  results.positions.length,
        orderCount:     results.orders.length,
        claimableCount: results.claimable.length,
    };

    return results;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: object, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function sendError(res: ServerResponse, msg: string, status = 500) {
    sendJson(res, { ok: false, error: msg }, status);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // ── Serve dashboard HTML ─────────────────────────────────────────────────
    if (url === '/' || url === '/index.html') {
        if (!existsSync(HTML_FILE)) {
            res.writeHead(404); res.end('dashboard.html not found');
            return;
        }
        const html = readFileSync(HTML_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    // ── SSE live events ──────────────────────────────────────────────────────
    if (url === '/api/events') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // ── Aggregate data endpoint ──────────────────────────────────────────────
    if (url === '/api/dashboard') {
        try {
            const data = await fetchDashboardData();
            sendJson(res, data);
        } catch (e: any) {
            sendError(res, e.message);
        }
        return;
    }

    // ── Claim: POST /api/claim/:slug ─────────────────────────────────────────
    const claimMatch = url.match(/^\/api\/claim\/(.+)$/);
    if (claimMatch && req.method === 'POST') {
        const slug = decodeURIComponent(claimMatch[1]);
        if (!redeemer) { sendError(res, 'PRIVATE_KEY not configured', 400); return; }
        try {
            const tx = await redeemer.redeemSingle(slug);
            sendJson(res, { ok: true, tx });
            // Trigger a refresh for connected browsers after a successful claim
            if (tx) sseWrite({ type: 'update', ts: Date.now() });
        } catch (e: any) {
            sendError(res, e.message);
        }
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
    console.log('\n📊 Limitless Agent Dashboard');
    console.log(`   → http://localhost:${PORT}\n`);
    console.log('   SSE live updates every 30 s. Press Ctrl+C to stop.\n');
    if (!walletAddress) {
        console.warn('   ⚠  No PRIVATE_KEY set — order & claim endpoints disabled.\n');
    }
});

server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} already in use. Set DASHBOARD_PORT= to override.\n`);
    } else {
        console.error('\n❌ Server error:', err.message);
    }
    process.exit(1);
});
