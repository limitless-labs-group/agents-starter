/**
 * Autonomous Strategy Iterator
 * 
 * Designed to be called by an AI agent (OpenClaw cron or heartbeat) to:
 * 1. Check wallet balance and positions
 * 2. Analyze trade history — find what's working
 * 3. Generate recommendations — suggest parameter improvements
 * 4. Scan current market opportunities
 * 
 * This is the "brain" that an AI agent uses to improve strategies over time.
 * 
 * Usage:
 *   npx tsx src/strategies/iterate.ts report        # Full status report
 *   npx tsx src/strategies/iterate.ts analyze       # Analyze + recommendations
 *   npx tsx src/strategies/iterate.ts markets       # Scan current market opportunities
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { getWallet } from '../core/wallet.js';
import { LimitlessClient } from '../core/limitless/markets.js';
import { getLearnings } from './signal-sniper/learnings.js';
import dotenv from 'dotenv';

dotenv.config();

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`;
const ITERATION_LOG = './iteration-log.jsonl';

async function getBalance(): Promise<string> {
  const viemClient = createPublicClient({ chain: base, transport: http() });
  const { account } = getWallet();
  const balance = await viemClient.readContract({
    address: USDC,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [account.address],
  });
  return formatUnits(balance, 6);
}

// ─── Report ──────────────────────────────────────────────

async function report(): Promise<string> {
  const balance = await getBalance();
  const learnings = getLearnings();
  
  let output = `\n🏦 Wallet: $${balance} USDC\n`;
  output += `📋 Trades: ${learnings.totalTrades} total\n`;
  
  if (learnings.totalTrades > 0) {
    output += `  Wins: ${learnings.wins} | Losses: ${learnings.losses} | Pending: ${learnings.pending}\n`;
    output += `  Win Rate: ${(learnings.winRate * 100).toFixed(1)}%\n`;
    output += `  Avg Edge on Wins: ${learnings.avgEdgeOnWins.toFixed(1)}%\n`;
    output += `  Avg Edge on Losses: ${learnings.avgEdgeOnLosses.toFixed(1)}%\n`;
  }
  
  return output;
}

// ─── Market Scanner ──────────────────────────────────────

async function scanMarkets(): Promise<string> {
  const limitless = new LimitlessClient();
  
  let output = '🔍 Active CLOB Markets:\n\n';
  let oppCount = 0;
  
  const markets = await limitless.getActiveMarkets({ tradeType: 'clob', limit: 50 });
  
  for (const market of markets) {
    if (!market.prices || market.prices.length < 2) continue;
    
    const yesPrice = market.prices[0];
    const noPrice = market.prices[1];
    const total = yesPrice + noPrice;
    
    // Flag interesting markets
    const isSkewed = yesPrice < 0.15 || yesPrice > 0.85;
    const isArbable = total < 0.97;
    const expMs = market.expirationTimestamp;
    const minutesToExpiry = expMs ? (expMs - Date.now()) / 60000 : Infinity;
    const isExpiringSoon = minutesToExpiry > 0 && minutesToExpiry < 120;
    
    if (isSkewed || isArbable || isExpiringSoon) {
      oppCount++;
      const flags = [
        isSkewed ? ' SKEWED' : '',
        isArbable ? `💰 ARB (${((1-total)*100).toFixed(1)}%)` : '',
        isExpiringSoon ? `⏰ ${minutesToExpiry.toFixed(0)}m` : '',
      ].filter(Boolean).join(' ');
      
      output += `  ${market.title}\n`;
      output += `    YES=${(yesPrice*100).toFixed(1)}¢ NO=${(noPrice*100).toFixed(1)}¢ ${flags}\n`;
      output += `    ${market.slug}\n\n`;
    }
  }
  
  output += `\nTotal interesting markets: ${oppCount}\n`;
  return output;
}

// ─── Analyze & Recommend ─────────────────────────────────

async function analyze(): Promise<string> {
  const balance = await getBalance();
  const learnings = getLearnings();
  const recommendations: string[] = [];
  
  let output = `\n🧠 Strategy Analysis (${new Date().toISOString()})\n`;
  output += `Wallet: $${balance}\n\n`;
  
  // Analyze trade history
  if (learnings.totalTrades === 0) {
    recommendations.push('No trades yet. Start with DRY_RUN=true to see what the bot would trade.');
  } else if (learnings.totalTrades < 10) {
    recommendations.push('Need more data — keep running with small bets.');
  } else {
    if (learnings.winRate < 0.5) {
      recommendations.push('Win rate below 50% — increase edge threshold.');
    }
    if (learnings.winRate > 0.7 && learnings.totalTrades > 20) {
      recommendations.push('Strong win rate — consider increasing bet size slightly.');
    }
    if (learnings.avgEdgeOnLosses > learnings.avgEdgeOnWins) {
      recommendations.push('Losing on higher edge bets — check price volatility near expiry.');
    }
  }
  
  // Scan current opportunities
  try {
    const marketScan = await scanMarkets();
    output += marketScan;
  } catch (e: any) {
    output += `\nWARNING: Market scan failed: ${e.message}\n`;
  }
  
  // Recommendations
  output += '\n Recommendations:\n';
  if (recommendations.length === 0) {
    output += '  None — keep iterating.\n';
  } else {
    for (const rec of recommendations) {
      output += `  • ${rec}\n`;
    }
  }
  
  // Log iteration
  const iterResult = {
    timestamp: new Date().toISOString(),
    action: 'analyze',
    walletBalance: balance,
    totalTrades: learnings.totalTrades,
    winRate: learnings.winRate,
    recommendations,
  };
  appendFileSync(ITERATION_LOG, JSON.stringify(iterResult) + '\n');
  
  return output;
}

// ─── Main CLI ────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'report';
  
  switch (cmd) {
    case 'report':
      console.log(await report());
      break;
    case 'analyze':
      console.log(await analyze());
      break;
    case 'markets':
      console.log(await scanMarkets());
      break;
    default:
      console.log('Usage: iterate.ts [report|analyze|markets]');
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
