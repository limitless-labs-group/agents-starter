import { appendFileSync, existsSync, readFileSync } from 'fs';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'learnings' });

export interface TradeRecord {
    timestamp: string;
    market: string;
    asset: string;
    strike: number;
    priceAtEntry: number;
    side: 'YES' | 'NO';
    betSize: number;
    edgePercent: number;
    hoursToExpiry: number;
    // Filled after resolution
    outcome?: 'WIN' | 'LOSS';
    priceAtResolution?: number;
    pnl?: number;
}

const LEARNINGS_FILE = './learnings.jsonl';

export function recordTrade(trade: Omit<TradeRecord, 'timestamp'>): void {
    const record: TradeRecord = {
        ...trade,
        timestamp: new Date().toISOString()
    };
    
    try {
        appendFileSync(LEARNINGS_FILE, JSON.stringify(record) + '\n');
        logger.info({ market: trade.market, side: trade.side, edge: trade.edgePercent }, 'Trade recorded');
    } catch (e) {
        logger.error({ error: e }, 'Failed to record trade');
    }
}

export function getLearnings(): { 
    totalTrades: number;
    wins: number;
    losses: number;
    pending: number;
    avgEdgeOnWins: number;
    avgEdgeOnLosses: number;
    winRate: number;
} {
    if (!existsSync(LEARNINGS_FILE)) {
        return { totalTrades: 0, wins: 0, losses: 0, pending: 0, avgEdgeOnWins: 0, avgEdgeOnLosses: 0, winRate: 0 };
    }
    
    const lines = readFileSync(LEARNINGS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const trades: TradeRecord[] = lines.map(l => JSON.parse(l));
    
    const wins = trades.filter(t => t.outcome === 'WIN');
    const losses = trades.filter(t => t.outcome === 'LOSS');
    const pending = trades.filter(t => !t.outcome);
    
    return {
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        pending: pending.length,
        avgEdgeOnWins: wins.length ? wins.reduce((s, t) => s + t.edgePercent, 0) / wins.length : 0,
        avgEdgeOnLosses: losses.length ? losses.reduce((s, t) => s + t.edgePercent, 0) / losses.length : 0,
        winRate: (wins.length + losses.length) > 0 ? wins.length / (wins.length + losses.length) : 0
    };
}

export function suggestAdjustments(): string[] {
    const stats = getLearnings();
    const suggestions: string[] = [];
    
    if (stats.totalTrades < 10) {
        suggestions.push('Need more data - keep running with small bets');
        return suggestions;
    }
    
    if (stats.winRate < 0.5) {
        suggestions.push('Win rate below 50% - increase edge threshold');
    }
    
    if (stats.avgEdgeOnLosses > stats.avgEdgeOnWins) {
        suggestions.push('Losing on higher edge bets - check price volatility near expiry');
    }
    
    if (stats.winRate > 0.7 && stats.totalTrades > 20) {
        suggestions.push('Strong win rate - consider increasing bet size slightly');
    }
    
    return suggestions;
}
