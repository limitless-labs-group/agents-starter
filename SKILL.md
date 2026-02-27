# Limitless Prediction Market Trading Agent

Complete SDK and strategy framework for autonomous prediction market trading on Limitless Exchange (Base chain).

This file is the operating manual. An agent with shell access and this file can go from zero to live trading autonomously.

---

## Quick Start Prompt

Paste this into your Clawbot (or any coding agent with shell access) to go from zero to live trading in one shot. The agent clones the repo, reads this file, and handles the rest.

```
Clone https://github.com/limitless-labs-group/agents-starter.git — your operating manual is SKILL.md, read it before doing anything else.

Then ask me for two things:
→ PRIVATE_KEY — Base chain private key (dedicated trading wallet, never your main)
→ LIMITLESS_API_KEY — from limitless.exchange → Profile → API Keys

Once I give you those: dry run first, then walk me through the available strategies so I can pick one. Start the dashboard so I can monitor performance. Set up hourly auto-claim to collect winnings from resolved markets automatically.

Keep me posted. Fix problems quietly.
```

---

## Agent Setup Wizard

Follow these steps in order. Each step builds on the previous one.

### Step 1: Clone and Install

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git ~/limitless-trader
cd ~/limitless-trader
npm install
cp .env.example .env
```

### Step 2: Configure Credentials

Edit `.env` and set these required values. Ask your user for them if not provided:

```
PRIVATE_KEY=0x...          # Base chain wallet private key (dedicated trading wallet)
LIMITLESS_API_KEY=lmts_... # From limitless.exchange -> Profile -> API Keys
```

The wallet needs USDC (collateral) and a small amount of ETH (gas, ~$1-2) on Base chain.

### Step 3: Verify Wallet

```bash
npx tsx -e "
import { getWallet } from './src/core/wallet.js';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
const { account } = getWallet();
const client = createPublicClient({ chain: base, transport: http() });
const usdc = await client.readContract({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  abi: [{ name: 'balanceOf', type: 'function', inputs: [{type:'address'}], outputs: [{type:'uint256'}], stateMutability: 'view' }],
  functionName: 'balanceOf', args: [account.address]
});
console.log('Address:', account.address);
console.log('USDC:', formatUnits(usdc, 6));
"
```

If USDC is 0, the user needs to fund the wallet before proceeding.

### Step 4: Dry Run

```bash
DRY_RUN=true npm run conviction-sniper
```

Confirm: markets are scanned, no orders placed. If this works, the setup is correct.

### Step 5: Go Live

Edit `.env`:
```
DRY_RUN=false
SNIPER_BET_SIZE=0.50
SNIPER_ASSETS=BTC,ETH,SOL
SNIPER_MIN_LEAD=0.65
SNIPER_MAX_LEAD=0.93
SNIPER_MIN_CONVICTION=3.0
SNIPER_MIN_MINUTES=3
SNIPER_MAX_MINUTES=25
```

Start with PM2 for persistence:
```bash
pm2 start "npx tsx src/strategies/conviction-sniper/run.ts" --name conviction-sniper --max-restarts 999 --restart-delay 5000
pm2 start "npx tsx src/dashboard.ts" --name dashboard
pm2 logs conviction-sniper --lines 20
```

### Step 6: Monitor

Dashboard: `http://localhost:3456` (or set `DASHBOARD_PORT`)

Check logs: `pm2 logs oracle-live --lines 50`

Claim winnings: `npx tsx src/core/limitless/redeem.ts claim-all`

### Step 7: Iterate

Read `data/oracle-arb-trades.jsonl` for trade history. Analyze fill rates, win rates by asset, and edge distribution. Adjust `.env` parameters and restart:

```bash
pm2 restart oracle-live
```

Log parameter changes to `data/iteration-log.jsonl` for tracking what works.

### Emergency Stop

```bash
pm2 stop oracle-live
npx tsx src/core/limitless/redeem.ts claim-all
```

---

## Strategy Notes

The oracle-arb strategy uses Pyth Hermes SSE for sub-second oracle prices and compares them against Limitless market pricing. When the oracle shows strong conviction that a market is mispriced, it fires FOK (Fill-or-Kill) orders.

Key behaviors:

- **Checks actual orderbook ask before ordering.** The API's displayed price can be stale. The strategy fetches the real ask and validates it against `ORACLE_MAX_PRICE` before placing any order.
- **FOK orders only.** Fill instantly or reject. No ghost orders on the book.
- **Continuous scanning** with faster intervals during the golden window (xx:57-xx:03 of each hour) when new markets appear.
- **Auto-approval.** First trade on a new market triggers automatic USDC/CTF approval.
- **Position tracking.** Prevents duplicate bets on the same market.

What works: targeting balanced markets (30-70% odds) where the orderbook has real liquidity below 75 cents. Hit the ask, don't fish.

---

## Key Files

| File | Purpose |
|------|---------|
| `.env` | All strategy configuration |
| `src/strategies/oracle-arb/index.ts` | Main strategy logic |
| `src/strategies/base-strategy.ts` | Strategy base class (tick loop, order execution) |
| `src/core/limitless/trading.ts` | Order creation, signing, submission |
| `src/core/limitless/markets.ts` | Market discovery, orderbook, search |
| `src/core/limitless/redeem.ts` | Claim winnings from resolved markets |
| `src/core/price-feeds/hermes.ts` | Pyth Hermes SSE price streaming |
| `src/dashboard.ts` | Analytics dashboard server |
| `data/oracle-arb-trades.jsonl` | Trade execution log |
| `data/oracle-arb-positions.json` | Current tracked positions |
| `data/pnl-tracker.json` | Realized P&L from claims |

---

## Table of Contents

1. [Agent Setup Wizard](#agent-setup-wizard) — start here
2. [Strategy Notes](#strategy-notes)
3. [Key Files](#key-files)
4. [Overview](#1-overview)
5. [Live Documentation (MCP)](#2-live-documentation-mcp)
6. [Market Structure](#3-market-structure)
7. [Architecture](#4-architecture)
8. [Setup Guide](#5-setup-guide)
9. [Core SDK Reference](#6-core-sdk-reference)
10. [EIP-712 Signing Deep Dive](#7-eip-712-signing-deep-dive)
11. [Contract Addresses](#8-contract-addresses)
12. [Strategies Reference](#9-strategies-reference)
13. [Building Your Own Strategy](#10-building-your-own-strategy)
14. [Autonomous Iteration](#11-autonomous-iteration)
15. [Safety and Risk Management](#12-safety--risk-management)
16. [Common Patterns and Recipes](#13-common-patterns--recipes)
17. [Agent Integration Patterns](#14-agent-integration-patterns)
18. [Troubleshooting](#15-troubleshooting)
19. [Links and Resources](#15-links--resources)

---

## 1. Overview

### What Are Prediction Markets?

Prediction markets let people trade on the outcomes of future events. Each market poses a question — "Will BTC be above $100,000 on March 1?" — and offers binary tokens: **YES** and **NO**. These tokens trade between $0.00 and $1.00, with prices reflecting the crowd's estimated probability of the event occurring.

At resolution:
- If the event **happens**: YES tokens pay $1.00, NO tokens pay $0.00
- If the event **doesn't happen**: YES tokens pay $0.00, NO tokens pay $1.00

This means YES price + NO price should always equal ~$1.00. When they don't, arbitrage opportunities exist.

### What Is Limitless Exchange?

Limitless Exchange is the #1 prediction market protocol on Base chain. Key features:

- **Central Limit Order Book (CLOB)** — full orderbook trading with limit orders, not just AMM swaps
- **AMM markets** — simpler automated market maker pools for some markets
- **NegRisk / Group markets** — multi-outcome markets (e.g., "Which team wins the Super Bowl?") where multiple YES/NO pairs share a single collateral pool
- **Conditional Tokens Framework (CTF)** — ERC-1155 position tokens compatible with the Gnosis CTF standard
- **USDC collateral** — all markets settle in USDC on Base chain
- **Sub-minute markets** — crypto price bracket markets that expire in minutes to hours, creating rapid trading opportunities

### What This Skill Enables

This skill gives an AI agent the complete toolkit to:

1. **Discover markets** — search, filter, and scan all active prediction markets
2. **Evaluate opportunities** — compare external price feeds against market odds to find mispricing
3. **Execute trades** — sign and submit EIP-712 limit orders to the CLOB
4. **Manage positions** — track open orders, portfolio P&L, and exposure
5. **Redeem winnings** — automatically claim payouts from resolved markets
6. **Learn and iterate** — log every trade, analyze win/loss patterns, and adjust strategy parameters over time
7. **Run autonomously** — operate on a cron/heartbeat loop, scanning → trading → analyzing → improving

---

## 2. Live Documentation (MCP)

### CRITICAL: Always Query the Docs First

Limitless Exchange provides a live documentation search endpoint via the **Model Context Protocol (MCP)**. This is the single most important tool for staying accurate. The API evolves — endpoints change, parameters get added, response formats shift. **Before implementing any API call, verify it against the live docs.**

### MCP Endpoint

```
POST https://docs.limitless.exchange/mcp
```

### Protocol

JSON-RPC 2.0 over Server-Sent Events (SSE).

### Required Headers

```
Content-Type: application/json
Accept: text/event-stream, application/json
```

### Available Tool

| Tool Name | Parameter | Description |
|-----------|-----------|-------------|
| `SearchLimitlessExchange` | `query` (string) | Searches the Limitless Exchange documentation |

### How to Call It

```bash
curl -s -X POST "https://docs.limitless.exchange/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"SearchLimitlessExchange","arguments":{"query":"how to place an order"}}}'
```

### Response Format

The response arrives as an SSE stream:

```
event: message
data: {"result":{"content":[{"text":"...documentation content..."}]}}
```

Parse the `data` field as JSON, then extract `result.content[0].text` for the documentation text.

### When to Use the MCP

**Before every major action:**

| Situation | Example Query |
|-----------|---------------|
| Implementing an API call | `SearchLimitlessExchange("GET /markets/active parameters")` |
| Encountering an error | `SearchLimitlessExchange("order rejected error codes")` |
| Building a new strategy | `SearchLimitlessExchange("available market types and venues")` |
| Unsure about signing | `SearchLimitlessExchange("EIP-712 order signing format")` |
| Checking order format | `SearchLimitlessExchange("POST /orders request body")` |
| Understanding token IDs | `SearchLimitlessExchange("position IDs token IDs conditional tokens")` |
| Exploring new endpoints | `SearchLimitlessExchange("portfolio API endpoints")` |
| Debugging approvals | `SearchLimitlessExchange("USDC approval CTF approval")` |
| Understanding venues | `SearchLimitlessExchange("venue exchange adapter negrisk")` |
| Fee structure | `SearchLimitlessExchange("fee rate bps tiers")` |

### Integration Pattern for Agents

**Make MCP queries a reflex, not an afterthought.** Before:
- Writing a new API integration → query MCP
- Debugging a failing call → query MCP
- Adding a new strategy that touches a new endpoint → query MCP
- Modifying order parameters → query MCP

**Treat the live docs as the source of truth** — not the cached knowledge in this SKILL.md. This file is comprehensive but may lag behind API changes. The MCP endpoint always reflects the current state of the documentation.

### Programmatic Usage (TypeScript)

```typescript
async function queryLimitlessDocs(query: string): Promise<string> {
  const res = await fetch('https://docs.limitless.exchange/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'SearchLimitlessExchange',
        arguments: { query },
      },
    }),
  });

  const text = await res.text();
  // Parse SSE: find lines starting with "data: "
  const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line.slice(6));
      if (parsed.result?.content?.[0]?.text) {
        return parsed.result.content[0].text;
      }
    } catch {}
  }
  return '';
}
```

---

## 3. Market Structure

### Binary Markets

Every binary market has two outcome tokens:
- **YES token** — pays $1.00 if the event occurs
- **NO token** — pays $1.00 if the event does not occur

Prices are expressed as values between 0 and 1 (or 0¢ and 100¢). A YES price of 0.65 means the market estimates a 65% probability the event will occur.

**Key invariant:** At resolution, exactly one side pays $1.00 and the other pays $0.00. Before resolution, YES + NO prices should approximate $1.00 (deviations create arbitrage opportunities).

### Trading Venues: CLOB vs AMM

Limitless supports two trading venues:

| Feature | CLOB | AMM |
|---------|------|-----|
| Order type | Limit orders (price + size) | Swap against liquidity pool |
| Price discovery | Orderbook with bids/asks | Automated bonding curve |
| Execution | Maker/taker matching | Instant at pool price |
| Best for | Precise entry/exit, strategies | Quick trades, simple markets |
| `tradeType` field | `'clob'` | `'amm'` |

This SDK focuses on **CLOB markets** because they offer limit orders, better price control, and more strategic opportunities.

### NegRisk / Group Markets

Some markets have more than two outcomes (e.g., "Which candidate wins the election?"). These are **group markets** using the NegRisk framework:

- Multiple YES/NO pairs share a single collateral pool
- Each outcome has its own position ID (token ID)
- The `marketType` field is `'group'` and `tradeType` is `'group'`
- The venue includes both an `exchange` address and an `adapter` address
- Token approvals must be set for both the exchange AND the adapter

### Position IDs and Token IDs

Each market outcome has a unique **position ID** (also called token ID). These are uint256 values that identify ERC-1155 tokens in the CTF contract.

```typescript
// From market data:
market.positionIds[0]  // YES token ID
market.positionIds[1]  // NO token ID

// Or from raw API response:
market.tokens.yes      // YES token ID
market.tokens.no       // NO token ID
```

These token IDs are used in:
- EIP-712 order signing (the `tokenId` field)
- CTF balance checks (`balanceOf(address, tokenId)`)
- Redemption calls

### Collateral

All Limitless markets use **USDC on Base chain** as collateral. USDC has 6 decimals, so:
- 1 USDC = `1_000_000` raw units
- $0.50 = `500_000` raw units

### Market Lifecycle

```
CREATED → FUNDED → ACTIVE (trading open) → CLOSED (trading stopped) → RESOLVED (payouts available)
```

- **FUNDED**: Market is live, trading is open
- **CLOSED**: Trading has stopped, awaiting resolution
- **RESOLVED**: Outcome determined, winning tokens can be redeemed for USDC

The `status` field on a market object reflects this: `'FUNDED'` | `'CLOSED'` | `'RESOLVED'`.

### Resolution Mechanics

Markets are resolved by oracles. For crypto price markets, resolution is typically based on the actual price at expiration time. Once resolved:
- The `winningOutcomeIndex` field indicates which outcome won (0 = YES, 1 = NO)
- The CTF contract's `payoutDenominator` becomes > 0
- Holders of winning tokens can call `redeemPositions()` to convert tokens → USDC

### Market Prices Array

The `prices` field on a market object is an array: `[YES_price, NO_price]`.

- Values range from 0 to ~100 (representing cents / probability percentage)
- Example: `[42.8, 57.2]` means YES is 42.8¢, NO is 57.2¢
- For CLOB markets, these reflect the last traded or mid price

> 📖 **MCP checkpoint:** For the latest on market data fields and price format, query: `SearchLimitlessExchange("market object fields prices format")`

---

## 4. Architecture

### Directory Structure

```
src/
├── index.ts                           # CLI entry point — routes commands to strategies
├── core/
│   ├── wallet.ts                      # Private key → viem WalletClient + Account
│   ├── limitless/
│   │   ├── types.ts                   # All TypeScript interfaces & EIP-712 type definitions
│   │   ├── markets.ts                 # LimitlessClient — market discovery, search, orderbook
│   │   ├── trading.ts                 # TradingClient — order creation, cancellation, submission
│   │   ├── sign.ts                    # OrderSigner — EIP-712 typed data signing
│   │   ├── approve.ts                 # Token approvals — USDC (ERC-20) and CTF (ERC-1155)
│   │   ├── redeem.ts                  # RedeemClient — claim winnings from resolved markets
│   │   ├── portfolio.ts               # PortfolioClient — positions, trades, P&L, history
│   │   └── websocket.ts              # LimitlessWebSocket — real-time price & orderbook updates
│   └── price-feeds/
│       └── coingecko.ts               # CoinGeckoClient — external price data
├── strategies/
│   ├── base-strategy.ts               # BaseStrategy abstract class — tick loop, trade execution
│   ├── index.ts                       # Strategy registry — register & instantiate strategies
│   ├── iterate.ts                     # Iterator — report, analyze, market scan for AI agents
│   ├── signal-sniper/
│   │   ├── index.ts                   # SignalSniperStrategy — CoinGecko momentum trading
│   │   ├── run.ts                     # Standalone runner with dry-run support
│   │   └── learnings.ts              # Trade logging, win/loss tracking, suggestions
│   └── cross-market-arb/
│       ├── index.ts                   # ComplementArbStrategy — YES+NO < $1 arbitrage
│       └── run.ts                     # Standalone runner
```

### Module Dependency Graph

```
wallet.ts ──────────────────────┐
                                ▼
                          sign.ts (OrderSigner)
                                │
markets.ts (LimitlessClient) ───┤
                                ▼
                          trading.ts (TradingClient)
                                │
                    ┌───────────┤───────────────┐
                    ▼           ▼               ▼
             approve.ts    redeem.ts      portfolio.ts
                                │
                    ┌───────────┘
                    ▼
             base-strategy.ts (BaseStrategy)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
   signal-sniper/       cross-market-arb/
          │
          ▼
   learnings.ts ──→ iterate.ts
```

### Core Concepts

**Wallet** (`wallet.ts`): Reads `PRIVATE_KEY` from env, creates a viem `WalletClient` on Base chain. The account is used for both on-chain transactions (approvals, redemptions) and off-chain signing (EIP-712 orders).

**LimitlessClient** (`markets.ts`): Stateless HTTP client for the Limitless REST API. Caches venue data (exchange/adapter addresses) internally to avoid repeated lookups.

**TradingClient** (`trading.ts`): Orchestrates order creation — fetches market details, computes tick-aligned amounts, calls `OrderSigner`, and submits to the API. Respects `DRY_RUN` env var.

**OrderSigner** (`sign.ts`): Pure signing logic. Takes venue + order params, constructs the EIP-712 typed data, signs with the wallet, returns a `SignedOrder` ready for submission.

**BaseStrategy** (`base-strategy.ts`): Abstract class providing the tick loop pattern. Subclasses implement `initialize()`, `tick()`, `shutdown()`, and `getStats()`. The base class handles the timer, decision execution, and error recovery.

**Learnings** (`learnings.ts`): Append-only JSONL trade log. Every trade decision is recorded with context (asset, strike, edge, time-to-expiry). After resolution, outcomes can be backfilled for analysis.

---

## 5. Setup Guide

### Prerequisites

- **Node.js 18+** (check: `node --version`)
- **A wallet with USDC on Base chain** (dedicated trading wallet — NOT your main wallet)
- **A Limitless API key** (free, from the Limitless website)
- **Optional:** CoinGecko API key (for the signal-sniper strategy)

### Step 1: Clone & Install

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
```

### Step 2: Wallet Setup

**Create a dedicated trading wallet.** Never use your main wallet for automated trading.

Export your private key:
- **MetaMask:** Settings → Security & Privacy → Export Private Key
- **Rabby:** Settings → Security → Export Private Key

Fund the wallet with USDC on Base chain:
- Bridge USDC from Ethereum to Base via [bridge.base.org](https://bridge.base.org)
- Or buy USDC directly on Base via a DEX

**Recommended starting balance:** $10–$50 USDC. You can always add more later.

### Step 3: Get a Limitless API Key

1. Go to [limitless.exchange](https://limitless.exchange)
2. Connect your trading wallet
3. Navigate to Profile → API Keys
4. Click "Generate" and copy the key (starts with `lmts_`)

### Step 4: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# ─── REQUIRED ─────────────────────────────────────────────
PRIVATE_KEY=0x...your-64-char-hex-private-key
LIMITLESS_API_KEY=lmts_...your-api-key

# ─── SAFETY ───────────────────────────────────────────────
DRY_RUN=true                    # ALWAYS start with true. Set false only after validation.
MAX_TOTAL_EXPOSURE_USD=50       # Maximum total capital at risk across all positions
MAX_SINGLE_TRADE_USD=10         # Maximum single trade size

# ─── OPTIONAL ─────────────────────────────────────────────
COINGECKO_API_KEY=CG-...        # Required for signal-sniper strategy (free tier works)
LOG_LEVEL=info                  # debug | info | warn | error
LIMITLESS_API_URL=https://api.limitless.exchange  # Override API base URL
LIMITLESS_WS_URL=wss://ws.limitless.exchange      # Override WebSocket URL

# ─── SIGNAL SNIPER CONFIG ────────────────────────────────
SNIPER_ASSETS=bitcoin,ethereum,solana,dogecoin     # CoinGecko asset IDs to track
SNIPER_BET_SIZE=0.50            # USD per trade
SNIPER_MIN_EDGE=10              # Minimum edge % to trigger a trade
SNIPER_EXPERIMENT=signal-sniper-v1  # Experiment name for logging

# ─── COMPLEMENT ARB CONFIG ───────────────────────────────
ARB_BET_SIZE=10                 # USD per arb (split across YES+NO)
ARB_MIN_SPREAD=3                # Minimum spread % to trigger arb
ARB_SCAN_INTERVAL=30000         # Scan interval in ms
```

### Step 5: First Dry Run

```bash
# Run signal sniper in dry-run mode (no real trades)
npm run signal-sniper
```

You should see output like:
```
╔══════════════════════════════════════════════╗
║         SIGNAL SNIPER STRATEGY               ║
║  CoinGecko Signals • Edge Detection          ║
╚══════════════════════════════════════════════╝

  Assets:     bitcoin, ethereum, solana, dogecoin
  Edge:       >10%
  Bet size:   $0.50
  Mode:       DRY RUN
```

The bot will scan markets and log what it *would* trade without executing.

### Step 6: Market Approval (CRITICAL for AI Agents)

Limitless uses the Conditional Tokens Framework (CTF). Before trading on any market, you must approve the exchange to spend your USDC and handle CTF tokens. **This is a one-time, per-market requirement.**

#### Why This Matters

Each market has a unique venue (exchange contract address). The blockchain requires explicit approval before smart contracts can move your tokens. Attempting to trade without approval results in:
```
Error: Insufficient collateral allowance for this order
```

#### Option A: Manual Approval (CLI)

```bash
# Approve tokens for a specific market before trading
npx tsx src/index.ts approve <market-slug>

# Example:
npx tsx src/index.ts approve bitcoin-above-100k-2025-06-01
```

This sends on-chain approval transactions for:
1. **USDC → Exchange** (required for BUY orders)
2. **CTF → Exchange** (required for SELL orders)
3. **CTF → Adapter** (required for NegRisk/group market SELL orders)

Gas cost: ~$0.01-0.05 on Base chain per market.

#### Option B: Auto-Approval (Built-in to oracle-arb)

The oracle-arb strategy automatically detects approval errors and approves markets on-the-fly:

```typescript
// In oracle-arb/index.ts, the executeDecisions method:
if (errMsg.includes('not approved') || errMsg.includes('allowance')) {
    this.logger.info({ marketSlug }, 'Market not approved, auto-approving...');
    await this.approveMarket(decision.marketSlug);
    // Retry the order after approval
    await this.trading.createOrder({...});
}
```

**For AI agents:** Auto-approval is the recommended approach. It eliminates manual intervention and ensures the strategy self-heals when encountering new markets.

#### AI Agent Pattern: Handling Approval Errors

If building your own strategy, implement this pattern:

```typescript
try {
    await trading.createOrder({ marketSlug, side, ... });
} catch (error: any) {
    const errMsg = error?.message || String(error);
    
    if (errMsg.includes('allowance') || errMsg.includes('not approved')) {
        // Step 1: Approve the market
        await approveMarketVenue(marketSlug);
        
        // Step 2: Retry the order
        await trading.createOrder({ marketSlug, side, ... });
    } else {
        throw error; // Re-throw non-approval errors
    }
}
```

### Step 7: Go Live

```bash
# Edit .env: DRY_RUN=false
# Keep bet sizes small ($0.50-$2) until validated
npm run signal-sniper
```

---

## 6. Core SDK Reference

### LimitlessClient (`src/core/limitless/markets.ts`)

Market discovery and data. No authentication required for most endpoints, but the API key enables higher rate limits.

> 📖 **MCP checkpoint:** For the latest endpoint specs, query: `SearchLimitlessExchange("GET /markets/active parameters and response")`

#### Constructor

```typescript
const client = new LimitlessClient(baseUrl?: string);
// Default baseUrl: https://api.limitless.exchange
```

#### `getActiveMarkets(options?)`

Fetches all active (tradeable) markets.

```typescript
const markets = await client.getActiveMarkets({
  category?: number,           // Filter by category ID
  tradeType?: 'amm' | 'clob' | 'group',  // Filter by venue type
  limit?: number,              // Max results (default varies)
  offset?: number,             // Pagination offset
});
// Returns: Market[]
```

**Response shape:**
```typescript
interface Market {
  id: number;
  address: string;                    // Market contract address
  title: string;                      // "BTC above $97,000 on Feb 13?"
  prices: number[];                   // [YES_price, NO_price] — values 0-100
  tradeType: 'amm' | 'clob' | 'group';
  marketType: 'single' | 'group';
  slug: string;                       // URL-safe identifier, used in all API calls
  venue: { exchange: string; adapter: string };  // Contract addresses for signing
  positionIds: string[];              // [YES_tokenId, NO_tokenId]
  collateralToken: { address: string; decimals: number; symbol: string };
  volume: string;
  volumeFormatted: string;
  liquidity: string;
  liquidityFormatted: string;
  expirationTimestamp: number;        // Milliseconds since epoch
  status: 'FUNDED' | 'CLOSED' | 'RESOLVED';
}
```

#### `searchMarkets(query, options?)`

Full-text search across market titles.

```typescript
const markets = await client.searchMarkets('BTC', {
  similarityThreshold?: number,  // 0-1, default varies
  limit?: number,
  page?: number,
});
// Returns: Market[]
```

#### `getMarket(slug)`

Fetch full details for a single market.

```typescript
const market = await client.getMarket('btc-above-97000-feb-13');
// Returns: MarketDetail (extends Market with description, resolutionSource, etc.)
```

#### `getOrderbook(slug)`

Fetch the current orderbook for a CLOB market.

```typescript
const orderbook = await client.getOrderbook('btc-above-97000-feb-13');
// Returns: { bids: OrderbookLevel[], asks: OrderbookLevel[], midpoint?: number }
// OrderbookLevel: { price: string, size: string }
```

> 📖 **MCP checkpoint:** For orderbook format details, query: `SearchLimitlessExchange("orderbook endpoint response format")`

#### `getSlugs()`

Get all active market slugs (lightweight — no full market data).

```typescript
const slugs = await client.getSlugs();
// Returns: string[]
```

#### `getCategoriesCount()`

Get count of markets per category.

```typescript
const counts = await client.getCategoriesCount();
// Returns: Record<string, number>  e.g. { "Crypto": 45, "Sports": 12 }
```

#### `getFeedEvents(slug)`

Get the activity feed for a market (trades, comments, etc.).

```typescript
const events = await client.getFeedEvents('btc-above-97000-feb-13');
// Returns: FeedEvent[]
```

#### `getVenue(slug)`

Get venue info (exchange + adapter addresses) for a market. Uses internal cache.

```typescript
const venue = await client.getVenue('btc-above-97000-feb-13');
// Returns: { exchange: string, adapter: string }
```

---

### TradingClient (`src/core/limitless/trading.ts`)

Order creation and management. Requires `LIMITLESS_API_KEY`.

> 📖 **MCP checkpoint:** For the latest order submission format, query: `SearchLimitlessExchange("POST /orders request body format")`

#### Constructor

```typescript
const trading = new TradingClient(
  client: LimitlessClient,
  signer: OrderSigner,
  baseUrl?: string
);
```

#### `createOrder(params)`

The main trading method. Fetches market details, computes tick-aligned amounts, signs the order via EIP-712, and submits to the API.

```typescript
const result = await trading.createOrder({
  marketSlug: 'btc-above-97000-feb-13',
  side: 'YES',                    // 'YES' or 'NO'
  limitPriceCents: 50,             // Price in cents (50 = $0.50)
  usdAmount: 2.00,                // Total USD to spend
});
```

**What happens internally:**
1. Fetches market detail (cached for 2 min) to get venue and token IDs
2. Selects the correct token ID: `positionIds[0]` for YES, `positionIds[1]` for NO
3. Computes `makerAmount` (USDC you pay) and `takerAmount` (contracts you receive)
4. Tick-aligns amounts: contracts must be multiples of 1000
5. Signs the order via `OrderSigner.signOrder()`
6. Fetches user profile ID via `getUserId()`
7. Submits `POST /orders` with the signed order + metadata
8. If `DRY_RUN=true`, logs the order and returns `{ status: 'DRY_RUN' }` without submitting

**Amount calculation (tick alignment):**
```typescript
const price = limitPriceCents / 100;                          // e.g. 0.50
const TICK_SIZE = 1000n;
const rawContracts = BigInt(Math.floor(usdAmount * 1_000_000 / price));
const takerAmount = (rawContracts / TICK_SIZE) * TICK_SIZE;   // Tick-aligned
const makerAmount = (takerAmount * priceScaled) / 1_000_000n; // USDC to pay
```

#### `getUserId(walletAddress)`

Fetches the Limitless user profile ID for a wallet address. Cached after first call.

```typescript
const userId = await trading.getUserId('0x1234...');
// Returns: number (user ID)
```

#### `getUserOrders(slug, status?)`

Get your orders for a specific market.

```typescript
const orders = await trading.getUserOrders('btc-above-97000-feb-13', 'OPEN');
// Note: API uses 'LIVE' internally for open orders
// Returns: Order[]
```

#### `cancelOrder(orderId)`

Cancel a single open order.

```typescript
await trading.cancelOrder('order-uuid-here');
```

#### `cancelBatch(orderIds)`

Cancel multiple orders at once.

```typescript
await trading.cancelBatch(['order-1', 'order-2', 'order-3']);
```

#### `cancelAllOrders(marketSlug)`

Cancel all your open orders on a market.

```typescript
await trading.cancelAllOrders('btc-above-97000-feb-13');
```

#### `getHistoricalPrice(slug, period?)`

Get historical price data for charting.

```typescript
const data = await trading.getHistoricalPrice('btc-above-97000-feb-13', '1d');
// period: '1d' | '1w' | '1m' | 'all'
```

#### `getLockedBalance(slug)`

Get locked collateral for a market.

```typescript
const { locked } = await trading.getLockedBalance('btc-above-97000-feb-13');
```

---

### OrderSigner (`src/core/limitless/sign.ts`)

EIP-712 typed data signing for CLOB orders. This is the cryptographic core — it produces signatures that the exchange contract verifies on-chain.

#### Constructor

```typescript
const signer = new OrderSigner(
  wallet: WalletClient,      // viem wallet client
  account: LocalAccount,     // viem local account (from privateKeyToAccount)
  chainId?: number            // Default: 8453 (Base)
);
```

#### `signOrder(marketVenue, orderParams)`

Signs an order using EIP-712 typed data.

```typescript
const signedOrder = await signer.signOrder(
  market.venue,                           // { exchange: '0x...', adapter: '0x...' }
  {
    tokenId: market.positionIds[0],       // YES or NO token ID
    makerAmount: 500000n,                 // USDC amount (raw, 6 decimals)
    takerAmount: 1000000n,               // Contracts to receive (raw)
    side: 'BUY',                          // 'BUY' or 'SELL'
    expiration?: 0,                       // 0 = no expiration
    feeRateBps?: 300,                     // Default: 300 (3%, Bronze tier)
    nonce?: 0,                            // Order nonce
  }
);
// Returns: SignedOrder
```

**SignedOrder structure:**
```typescript
interface SignedOrder {
  salt: string;             // Unique order identifier (timestamp-based)
  maker: string;            // Your wallet address (checksummed)
  signer: string;           // Same as maker for EOA wallets
  taker: string;            // '0x0000...0000' for open orders
  tokenId: string;          // Position token ID
  makerAmount: string;      // USDC you provide (raw units)
  takerAmount: string;      // Contracts you receive (raw units)
  expiration: string;       // '0' for no expiration
  nonce: number;            // Order nonce
  feeRateBps: number;       // Fee rate in basis points
  side: 0 | 1;              // 0 = BUY, 1 = SELL
  signatureType: number;    // 0 = EOA
  signature: string;        // Hex-encoded EIP-712 signature
}
```

#### `getAddress()`

Returns the signer's wallet address.

```typescript
const address = signer.getAddress();
// Returns: string (checksummed address)
```

---

### Token Approvals (`src/core/limitless/approve.ts`)

Before trading on any market, you must approve the venue's contracts to spend your tokens.

#### `approveMarketVenue(marketSlug)`

One-call approval for all required tokens on a market's venue.

```typescript
import { approveMarketVenue } from './core/limitless/approve.js';

await approveMarketVenue('btc-above-97000-feb-13');
```

**What it does:**
1. Fetches the market's venue (exchange + adapter addresses)
2. Approves USDC (ERC-20 `approve`) for the exchange → required for BUY orders
3. Approves CTF (ERC-1155 `setApprovalForAll`) for the exchange → required for SELL orders
4. If adapter exists (NegRisk markets): approves CTF for the adapter too

**Important:** Approvals are on-chain transactions that cost gas (ETH on Base). Each approval only needs to be done once per venue address.

> 📖 **MCP checkpoint:** For approval requirements, query: `SearchLimitlessExchange("token approvals USDC CTF required")`

---

### RedeemClient (`src/core/limitless/redeem.ts`)

Claim USDC payouts from resolved markets where you hold winning tokens.

#### Constructor

```typescript
const redeemer = new RedeemClient();
// Uses PRIVATE_KEY from env
```

#### `findClaimablePositions(marketSlugs)`

Scan a list of markets for claimable winning positions.

```typescript
const claimable = await redeemer.findClaimablePositions([
  'btc-above-97000-feb-13',
  'eth-above-3000-feb-14',
]);
// Returns: ClaimablePosition[]
```

**ClaimablePosition:**
```typescript
interface ClaimablePosition {
  marketSlug: string;
  marketTitle: string;
  conditionId: `0x${string}`;
  winningOutcomeIndex: number;    // 0 = YES won, 1 = NO won
  side: 'YES' | 'NO';
  balance: bigint;                // Raw token balance
  expectedPayout: string;         // Human-readable, e.g. "2.500000 USDC"
}
```

#### `redeemPositions(conditionId, indexSets)`

Redeem tokens for a specific resolved condition.

```typescript
const txHash = await redeemer.redeemPositions(
  '0xabc123...',   // conditionId from market data
  [1]              // indexSets: [1] = YES, [2] = NO, [1,2] = both
);
```

**Index sets explained:**
- `[1]` = redeem YES tokens (2^0 = 1)
- `[2]` = redeem NO tokens (2^1 = 2)
- `[1, 2]` = redeem both sides

#### `claimAll(marketSlugs)`

Convenience method: find all claimable positions and redeem them all.

```typescript
const result = await redeemer.claimAll(allTradedMarketSlugs);
// Returns: { claimed: number, totalValue: string, txHashes: string[] }
```

#### CLI Usage

```bash
# Check a specific market
npx tsx src/core/limitless/redeem.ts check <market-slug>

# Claim from specific markets
npx tsx src/core/limitless/redeem.ts claim <slug1> <slug2> ...

# Claim all from learnings.jsonl (all markets you've ever traded)
npx tsx src/core/limitless/redeem.ts claim-all
```

---

### PortfolioClient (`src/core/limitless/portfolio.ts`)

Position tracking, trade history, and P&L analysis. Requires `LIMITLESS_API_KEY`.

> 📖 **MCP checkpoint:** For the latest portfolio endpoints, query: `SearchLimitlessExchange("portfolio API positions trades")`

#### Constructor

```typescript
const portfolio = new PortfolioClient(baseUrl?: string);
```

#### `getTrades()`

Get your complete trade history.

```typescript
const trades = await portfolio.getTrades();
// Returns: Trade[]
```

**Trade:**
```typescript
interface Trade {
  id: string;
  marketId: number;
  strategy: string;          // 'Buy' or 'Sell'
  outcome: string;           // 'YES' or 'NO'
  tradeAmount: string;       // Raw amount
  tradeAmountUSD: string;    // USD equivalent
  timestamp: string;
}
```

#### `getPositions()`

Get your current open positions with unrealized P&L.

```typescript
const positions = await portfolio.getPositions();
// Returns: Position[] (may be grouped by clob/amm)
```

**Position:**
```typescript
interface Position {
  market: { title: string; slug: string };
  positions: {
    yes?: { marketValue: string; unrealizedPnl: string; fillPrice: string };
    no?: { marketValue: string; unrealizedPnl: string; fillPrice: string };
  };
}
```

#### `getHistory(page?, limit?)`

Paginated trade history.

```typescript
const history = await portfolio.getHistory(1, 20);
```

#### `getPnlChart(period?)`

P&L over time for charting.

```typescript
const pnl = await portfolio.getPnlChart('1w');
// period: '1d' | '1w' | '1m' | 'all'
```

#### `getAllowance(type)`

Check token allowance status.

```typescript
const { allowance, spender } = await portfolio.getAllowance('clob');
// type: 'clob' | 'negrisk'
```

#### `getPoints()`

Get your Limitless points/rewards balance.

```typescript
const points = await portfolio.getPoints();
```

---

### LimitlessWebSocket (`src/core/limitless/websocket.ts`)

Real-time price and orderbook updates via Socket.IO.

#### Constructor & Connection

```typescript
const ws = new LimitlessWebSocket(
  url?: string,     // Default: wss://ws.limitless.exchange
  apiKey?: string   // Default: from LIMITLESS_API_KEY env
);

ws.connect();
```

#### Subscribing to Updates

```typescript
// Subscribe to AMM price updates (by market address)
ws.subscribeAmmPrices(['0xMarketAddress1', '0xMarketAddress2']);

// Subscribe to CLOB orderbook updates (by slug)
ws.subscribeClobOrderbook(['btc-above-97000-feb-13']);

// General subscribe (both)
ws.subscribe(slugs, addresses);

// Unsubscribe
ws.unsubscribe(slugs, addresses);
```

#### Listening for Events

```typescript
const socket = ws.underlyingSocket;
if (socket) {
  socket.on('newPriceData', (data) => {
    // data: { marketAddress, updatedPrices, ... }
    console.log('Price update:', data);
  });

  socket.on('orderbookUpdate', (data) => {
    // data: { marketSlug, bids, asks, timestamp }
    console.log('Orderbook update:', data);
  });
}
```

#### Disconnect

```typescript
ws.disconnect();
```

**Features:**
- Auto-reconnection with exponential backoff (1s–5s)
- Automatic resubscription on reconnect
- WebSocket transport only (no polling fallback)

---

### CoinGeckoClient (`src/core/price-feeds/coingecko.ts`)

External price data for calculating fair values in prediction markets.

#### Constructor

```typescript
const cg = new CoinGeckoClient(
  baseUrl?: string,    // Default: https://api.coingecko.com/api/v3
  apiKey?: string       // Default: from COINGECKO_API_KEY env
);
```

#### `getPrice(coinId, vsCurrency?)`

Get the current USD price for a coin.

```typescript
const price = await cg.getPrice('bitcoin');        // Returns: 97500.23
const price = await cg.getPrice('dogecoin');       // Returns: 0.0971
const price = await cg.getPrice('ethereum', 'eur');// Returns: 2850.50
```

**Notes:**
- Returns `0` on error (rate limit, network failure) — always check for this
- CoinGecko free tier: ~30 req/min. The demo API key raises this
- Common coin IDs: `bitcoin`, `ethereum`, `solana`, `dogecoin`, `cardano`

---

### Wallet (`src/core/wallet.ts`)

Wallet initialization from private key.

#### `getWallet()`

```typescript
import { getWallet } from './core/wallet.js';

const { client, account } = getWallet();
// client: WalletClient (viem) — for signing transactions and typed data
// account: LocalAccount (viem) — the account object with address
// client also has publicActions extended — can read chain state
```

**Environment:**
- Reads `PRIVATE_KEY` from env (must be `0x`-prefixed 32-byte hex, 66 chars total)
- Connects to Base chain (chainId 8453) via default HTTP RPC
- Throws on missing or malformed key

---

## 7. EIP-712 Signing Deep Dive

Every CLOB order on Limitless requires an EIP-712 signature. This is how the exchange verifies that you authorized the trade without requiring an on-chain transaction for every order.

### The Domain

```typescript
const domain = {
  name: 'Limitless CTF Exchange',
  version: '1',
  chainId: 8453,                          // Base mainnet
  verifyingContract: market.venue.exchange // Dynamic per market!
};
```

**Critical:** The `verifyingContract` is the exchange address from the market's venue data. It varies between markets. Always fetch it from the market detail — never hardcode it.

> 📖 **MCP checkpoint:** For the latest EIP-712 domain, query: `SearchLimitlessExchange("EIP-712 domain order signing")`

### The Order Type Struct

```typescript
const types = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ]
};
```

### Field-by-Field Explanation

| Field | Type | Description |
|-------|------|-------------|
| `salt` | uint256 | Unique order ID. This SDK uses `Date.now() + 86400000` (24h from now) |
| `maker` | address | Your wallet address (checksummed) |
| `signer` | address | Same as maker for EOA wallets |
| `taker` | address | `0x0000...0000` for open orders (anyone can fill) |
| `tokenId` | uint256 | The position token ID (YES or NO) from `market.positionIds` |
| `makerAmount` | uint256 | USDC you provide (raw units, 6 decimals). For BUY: the collateral |
| `takerAmount` | uint256 | Contracts you receive (raw units). Must be tick-aligned (multiple of 1000) |
| `expiration` | uint256 | `0` = no expiration. Otherwise, Unix timestamp in seconds |
| `nonce` | uint256 | Order nonce, typically `0` |
| `feeRateBps` | uint256 | Fee tier in basis points. `300` = 3% (Bronze tier) |
| `side` | uint8 | `0` = BUY, `1` = SELL |
| `signatureType` | uint8 | `0` = EOA signature |

### Computing makerAmount and takerAmount from Price + USD Amount

For a **BUY** order at a given price:

```typescript
// Inputs
const priceInCents = 50;                    // 50¢
const usdAmount = 2.00;                     // $2.00 to spend

// Step 1: Convert price to decimal
const price = priceInCents / 100;           // 0.50

// Step 2: Calculate raw contracts
const rawContracts = BigInt(Math.floor(usdAmount * 1_000_000 / price));
// = BigInt(Math.floor(2.00 * 1_000_000 / 0.50))
// = 4_000_000n

// Step 3: Tick-align (must be multiple of 1000)
const TICK_SIZE = 1000n;
const takerAmount = (rawContracts / TICK_SIZE) * TICK_SIZE;
// = 4_000_000n (already aligned)

// Step 4: Calculate USDC cost
const SCALE = 1_000_000n;
const priceScaled = BigInt(Math.floor(price * 1_000_000));  // 500_000n
const makerAmount = (takerAmount * priceScaled) / SCALE;
// = (4_000_000n * 500_000n) / 1_000_000n
// = 2_000_000n  ($2.00 USDC)
```

### Fee Rate BPS Tiers

| Tier | Fee Rate | `feeRateBps` Value |
|------|----------|-------------------|
| Bronze | 3% | `300` |

> 📖 **MCP checkpoint:** For the latest fee tiers, query: `SearchLimitlessExchange("fee rate bps tiers trading fees")`

### The Side Field

```
0 = BUY  — You provide USDC (makerAmount), receive outcome tokens (takerAmount)
1 = SELL — You provide outcome tokens (makerAmount), receive USDC (takerAmount)
```

---

## 8. Contract Addresses

All contracts are on **Base chain** (chainId: `8453`).

| Contract | Address | Purpose |
|----------|---------|---------|
| **USDC** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Collateral token (ERC-20, 6 decimals) |
| **CTF** | `0xC9c98965297Bc527861c898329Ee280632B76e18` | Conditional Tokens Framework (ERC-1155) |
| **Exchange** | *Dynamic — from `market.venue.exchange`* | CLOB order matching (verifyingContract for EIP-712) |
| **Adapter** | *Dynamic — from `market.venue.adapter`* | NegRisk adapter for group markets |

**WARNING: Never hardcode exchange/adapter addresses.** They vary per market and may change. Always fetch from `market.venue`.

**Block Explorer:** [basescan.org](https://basescan.org)

---

## 9. Strategies Reference

### Signal Sniper (`signal-sniper`)

**Concept:** Monitors external price feeds (CoinGecko) and compares the real-world price against prediction market strike prices. When the current price clearly indicates an outcome but the market hasn't adjusted, buy the underpriced side.

**Example:** BTC is at $97,500. Market "BTC above $97,000?" has YES at 60¢. Since BTC is already above the strike, YES should be much higher. Buy YES at 60¢, expect it to resolve at $1.00.

**Edge exploited:** Information latency — external price data updates faster than prediction market odds, especially for short-duration markets.

**Best market types:** Crypto price bracket markets with 5min–2hr expiry windows.

**Configuration:**

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `SNIPER_ASSETS` | `bitcoin,ethereum,solana,dogecoin` | CoinGecko coin IDs to track |
| `SNIPER_BET_SIZE` | `0.50` | USD per trade |
| `SNIPER_MIN_EDGE` | `10` | Minimum edge % to trigger trade |
| `SNIPER_EXPERIMENT` | `signal-sniper-v1` | Experiment name for learnings |

**Risk profile:** Medium. Depends on price stability between entry and expiry. High volatility near expiry can flip outcomes.

**Tick interval:** 15 seconds (fast for short-duration markets).

**How it evaluates:**
1. Fetch current price from CoinGecko
2. Search Limitless for markets matching the asset ticker
3. Parse the strike price from market title (e.g., "above $97,000")
4. Filter to CLOB markets expiring within 2 hours
5. Calculate fair value: `confidence = 0.50 + |percentFromStrike| * 40` (capped at 0.95)
6. Compare fair value against market price → if edge > threshold, trade

---

### Binary Complement Arb (`cross-market-arb`)

**Concept:** In a binary market, YES + NO must equal $1.00 at resolution. If you can buy both sides for less than $1.00, you're guaranteed a profit regardless of outcome.

**Example:** YES = $0.45, NO = $0.48. Total cost = $0.93. Buy both → guaranteed $1.00 at resolution → $0.07 profit (7.5% return).

**Edge exploited:** Market maker spread inefficiency, thin liquidity, or momentary pricing dislocations.

**Best market types:** Any binary CLOB market with thin liquidity.

**Configuration:**

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ARB_BET_SIZE` | `10` | Total USD per arb (split across YES + NO) |
| `ARB_MIN_SPREAD` | `3` | Minimum profit % to trigger |
| `ARB_SCAN_INTERVAL` | `30000` | Scan interval in ms |

**Risk profile:** Low (guaranteed profit if both sides fill). Main risk is partial fills — getting only one side means directional exposure.

**Tick interval:** 30 seconds (configurable).

---

## 10. Building Your Own Strategy

### Step 1: Extend BaseStrategy

Create a new directory and file:

```typescript
// src/strategies/my-strategy/index.ts
import { BaseStrategy, StrategyConfig, TradeDecision, StrategyStats } from '../base-strategy.js';

interface MyStrategyConfig extends StrategyConfig {
  myParam: number;
}

export class MyStrategy extends BaseStrategy {
  constructor(
    config: StrategyConfig,
    deps: { limitless: LimitlessClient; trading: TradingClient }
  ) {
    super(config, deps);
    this.tickIntervalMs = 30000; // How often to run tick()
  }

  async initialize(): Promise<void> {
    // One-time setup: load state, warm caches, check approvals
    this.logger.info('My strategy initialized');
  }

  async tick(): Promise<TradeDecision[]> {
    const decisions: TradeDecision[] = [];

    // 1. Fetch market data
    const markets = await this.limitless.getActiveMarkets({ tradeType: 'clob' });

    // 2. Evaluate each market
    for (const market of markets) {
      const fairValue = this.calculateFairValue(market);
      const marketPrice = market.prices[0] / 100; // Normalize to 0-1
      const edge = fairValue - marketPrice;

      if (edge > 0.10) { // 10% edge
        decisions.push({
          action: 'BUY',
          marketSlug: market.slug,
          side: 'YES',
          amountUsd: 1.00,
          priceLimit: Math.floor((marketPrice + 0.05) * 100),
          reason: `Fair=${fairValue.toFixed(2)}, Market=${marketPrice.toFixed(2)}, Edge=${(edge*100).toFixed(1)}%`
        });
      }
    }

    return decisions; // BaseStrategy handles execution
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down');
  }

  getStats(): StrategyStats {
    return {
      activePositions: 0,
      totalVolumeUsd: 0,
      pnlUsd: 0,
      lastTickDurationMs: 0,
    };
  }

  private calculateFairValue(market: any): number {
    // Your edge logic here
    return 0.5;
  }
}
```

### Step 2: Register the Strategy

```typescript
// src/strategies/index.ts — add:
import { MyStrategy } from './my-strategy/index.js';
registerStrategy('my-strategy', MyStrategy);
```

### Step 3: Create a Runner

```typescript
// src/strategies/my-strategy/run.ts
import { MyStrategy } from './index.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { OrderSigner } from '../../core/limitless/sign.js';
import { getWallet } from '../../core/wallet.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const limitless = new LimitlessClient();
  const { client, account } = getWallet();
  const signer = new OrderSigner(client, account);
  const trading = new TradingClient(limitless, signer);

  const strategy = new MyStrategy(
    { id: 'my-v1', type: 'my-strategy', enabled: true, myParam: 42 },
    { limitless, trading }
  );

  process.on('SIGINT', async () => { await strategy.stop(); process.exit(0); });
  await strategy.start();
}
main().catch(console.error);
```

### Step 4: Add npm Script

```json
// package.json
"scripts": {
  "my-strategy": "npx tsx src/strategies/my-strategy/run.ts"
}
```

### The tick() Loop Pattern

The `BaseStrategy` runs your `tick()` method on a timer:

```
initialize() → tick() → execute decisions → wait → tick() → execute → wait → ...
```

- `tick()` returns `TradeDecision[]` — the base class handles execution
- If `tick()` throws, the error is caught and logged — the loop continues
- The interval self-adjusts: `nextTick = max(1s, tickIntervalMs - tickDuration)`
- Call `stop()` to break the loop and run `shutdown()`

### Fair Value Calculation Approaches

Some general approaches to calculating fair value in prediction markets:

1. **External price comparison** — compare an oracle/feed price to the market's strike price
2. **Statistical models** — use historical volatility to estimate probability of reaching strike
3. **Cross-market comparison** — compare similar markets on different platforms
4. **Orderbook analysis** — detect imbalances in bid/ask depth as directional signals
5. **Time decay** — as expiry approaches, markets with clear outcomes should converge to 0 or 1

### Position Sizing

Common approaches:
- **Fixed size** — same USD amount per trade (simplest, used by included strategies)
- **Kelly criterion** — `f = (edge * odds - 1) / (odds - 1)` — sizes bets proportional to edge
- **Fractional Kelly** — use 25-50% of full Kelly to reduce variance

### Logging Learnings

Use the learnings system to track every trade for later analysis:

```typescript
import { recordTrade } from '../signal-sniper/learnings.js';

recordTrade({
  market: market.slug,
  asset: 'BTC',
  strike: 97000,
  priceAtEntry: 97500,
  side: 'YES',
  betSize: 1.00,
  edgePercent: 15.0,
  hoursToExpiry: 0.5,
});
```

### Adding New Price Feeds

Create a client in `src/core/price-feeds/`:

```typescript
// src/core/price-feeds/my-feed.ts
export class MyFeedClient {
  async getPrice(symbol: string): Promise<number> {
    const res = await fetch(`https://api.myfeed.com/price/${symbol}`);
    const data = await res.json();
    return data.price;
  }
}
```

Then use it in your strategy's `tick()` method alongside or instead of CoinGecko.

---

## 11. Autonomous Iteration

This is where AI agents shine. The `iterate.ts` module provides commands designed to be called by an AI agent on a schedule, creating a continuous improvement loop.

### Iterator Commands

```bash
# Quick status: wallet balance, trade count, win rate
npm run iterate
# or: npx tsx src/strategies/iterate.ts report

# Deep analysis: trade patterns, recommendations, market scan
npm run iterate:analyze
# or: npx tsx src/strategies/iterate.ts analyze

# Market scanner: find interesting opportunities right now
npm run iterate:markets
# or: npx tsx src/strategies/iterate.ts markets
```

### What Each Command Does

**`report`** — Fast status check:
- Wallet USDC balance
- Total trades, wins, losses, pending
- Win rate and average edge on wins/losses

**`analyze`** — Deep analysis + recommendations:
- Everything in `report`
- Scans all active CLOB markets for opportunities
- Flags skewed markets (YES < 15% or > 85%)
- Flags arbitrageable markets (YES + NO < 97%)
- Flags markets expiring within 2 hours
- Generates recommendations based on trade history patterns
- Logs the iteration to `iteration-log.jsonl`

**`markets`** — Pure market scan:
- Lists all active CLOB markets with interesting characteristics
- Groups by opportunity type (skewed, arb, expiring soon)

### The Autonomous Iteration Cycle

Set up a cron job or heartbeat to run this loop:

```
┌─────────────────────────────────────────────────────────┐
│  1. SCAN        npm run iterate:markets                 │
│     → Find opportunities across all active markets      │
│                                                         │
│  2. EVALUATE    Query MCP for any unknown market types   │
│     → Calculate fair values, edge sizes                 │
│                                                         │
│  3. TRADE       npm run signal-sniper (or custom)       │
│     → Execute on the best opportunities                 │
│                                                         │
│  4. ANALYZE     npm run iterate:analyze                  │
│     → Review what worked, what didn't                   │
│                                                         │
│  5. ADJUST      Edit .env or strategy config            │
│     → Tune edge thresholds, bet sizes, asset list       │
│                                                         │
│  6. REPEAT      Wait for next cycle                     │
└─────────────────────────────────────────────────────────┘
```

### Metrics to Track

| Metric | What It Tells You | Action |
|--------|-------------------|--------|
| Win rate (overall) | Strategy effectiveness | < 50% → increase edge threshold |
| Win rate by asset | Which assets you predict well | Drop low-performers, add more of winners |
| Win rate by edge size | Whether larger edges are more reliable | Find the sweet spot |
| Win rate by time-to-expiry | Optimal entry timing | Adjust when you enter relative to expiry |
| Average P&L per trade | Profitability per bet | Should be positive and growing |
| Max drawdown | Worst losing streak | If too high, reduce bet size |

### When to Scale Up vs Pull Back

**Scale up when:**
- Win rate > 65% over 30+ trades
- Consistent positive P&L across multiple days
- Edge patterns are stable and repeatable
- Wallet balance is growing

**Pull back when:**
- Win rate drops below 50% for 10+ trades
- Consecutive losses exceed 5
- Unusual market conditions (extreme volatility, illiquidity)
- Wallet balance drops below your minimum threshold

### The learnings.jsonl Format

Every trade is appended as a JSON line:

```json
{
  "timestamp": "2025-02-13T10:30:00.000Z",
  "market": "btc-above-97000-feb-13-1030",
  "asset": "BTC",
  "strike": 97000,
  "priceAtEntry": 97500,
  "side": "YES",
  "betSize": 0.50,
  "edgePercent": 15.2,
  "hoursToExpiry": 0.5,
  "outcome": "WIN",
  "priceAtResolution": 97800,
  "pnl": 0.42
}
```

Fields `outcome`, `priceAtResolution`, and `pnl` are filled in after resolution (manually or by a backfill script).

### OpenClaw Cron Example

```bash
# Every 30 minutes: scan and analyze
openclaw cron add "*/30 * * * *" "cd /path/to/agents-starter && npm run iterate:analyze"

# Every 2 hours: run the signal sniper for one cycle
openclaw cron add "0 */2 * * *" "cd /path/to/agents-starter && timeout 300 npm run signal-sniper"
```

### OpenClaw Heartbeat Integration

Add to your `HEARTBEAT.md`:

```markdown
## Trading Bot Checks
- [ ] Run `npm run iterate` in agents-starter — check wallet balance and win rate
- [ ] If win rate < 50% over last 20 trades, pause the strategy and investigate
- [ ] If wallet < $5 USDC, notify me
- [ ] Run `npm run iterate:markets` — any arb opportunities > 5%?
```

---

## 12. Safety & Risk Management

### Rule #1: DRY_RUN First, Always

**Every new strategy, every parameter change, every code modification** — run with `DRY_RUN=true` first. Watch the logs. Verify the decisions make sense. Only then set `DRY_RUN=false`.

### Position Sizing Rules

1. **Start with minimum bets** — $0.50–$1.00 per trade until you have 20+ winning trades
2. **Set `MAX_TOTAL_EXPOSURE_USD`** — the absolute maximum capital at risk across all positions
3. **Set `MAX_SINGLE_TRADE_USD`** — no single trade should risk more than 10% of your total bankroll
4. **Never go all-in** — keep reserves for new opportunities and to recover from losses

### Dedicated Wallet

**Always use a dedicated trading wallet with limited funds.** This provides:
- **Blast radius containment** — if the key is compromised, only the trading funds are at risk
- **Budget enforcement** — you can't accidentally risk your main holdings
- **Clean accounting** — easy to track P&L without mixing with other activity

### When to Stop

- Win rate drops below 45% over 20+ resolved trades
- 5+ consecutive losses
- Wallet balance drops below 50% of starting balance
- Market conditions change (new fee structure, API changes, liquidity dries up)
- You see unexpected behavior in the logs

### Never Risk More Than You Can Afford to Lose

Prediction markets are inherently risky. Even with an edge, variance is real. Funded with $50? Assume you might lose all $50. Comfortable with that? Good. Not comfortable? Fund less.

---

## 13. Common Patterns & Recipes

### Scan All Markets and Find the Best Opportunity

```bash
npm run iterate:markets
```

Or programmatically:

```typescript
const limitless = new LimitlessClient();
const markets = await limitless.getActiveMarkets({ tradeType: 'clob', limit: 100 });

const opportunities = markets
  .filter(m => m.prices && m.prices.length >= 2)
  .map(m => ({
    slug: m.slug,
    title: m.title,
    yesPrice: m.prices[0],
    noPrice: m.prices[1],
    total: m.prices[0] + m.prices[1],
    spread: 100 - (m.prices[0] + m.prices[1]),
    expiresIn: (m.expirationTimestamp - Date.now()) / 60000,
  }))
  .filter(m => m.expiresIn > 0)
  .sort((a, b) => a.spread - b.spread); // Lowest total first = best arb
```

### Place a Limit Order at a Specific Price

```typescript
import { getWallet } from './core/wallet.js';
import { LimitlessClient } from './core/limitless/markets.js';
import { TradingClient } from './core/limitless/trading.js';
import { OrderSigner } from './core/limitless/sign.js';

const limitless = new LimitlessClient();
const { client, account } = getWallet();
const signer = new OrderSigner(client, account);
const trading = new TradingClient(limitless, signer);

// Buy YES at 45¢, spending $5
await trading.createOrder({
  marketSlug: 'btc-above-100000-mar-1',
  side: 'YES',
  limitPriceCents: 45,
  usdAmount: 5.00,
});
```

### Check My Open Positions and P&L

```typescript
import { PortfolioClient } from './core/limitless/portfolio.js';

const portfolio = new PortfolioClient();

const positions = await portfolio.getPositions();
console.log('Current positions:', JSON.stringify(positions, null, 2));

const pnl = await portfolio.getPnlChart('1w');
console.log('Weekly P&L:', pnl);
```

### Redeem All Resolved Winning Positions

```bash
# From learnings.jsonl (all markets you've traded)
npx tsx src/core/limitless/redeem.ts claim-all
```

Or programmatically:

```typescript
import { RedeemClient } from './core/limitless/redeem.js';
import { readFileSync } from 'fs';

const redeemer = new RedeemClient();
const lines = readFileSync('./learnings.jsonl', 'utf-8').trim().split('\n');
const slugs = [...new Set(lines.map(l => JSON.parse(l).market))];

const result = await redeemer.claimAll(slugs);
console.log(`Claimed ${result.claimed} positions, total: $${result.totalValue} USDC`);
```

### Analyze My Last 50 Trades and Find Patterns

```bash
npm run iterate:analyze
```

Or manually inspect `learnings.jsonl`:

```typescript
import { getLearnings, suggestAdjustments } from './strategies/signal-sniper/learnings.js';

const stats = getLearnings();
console.log(`Win rate: ${(stats.winRate * 100).toFixed(1)}%`);
console.log(`Avg edge on wins: ${stats.avgEdgeOnWins.toFixed(1)}%`);
console.log(`Avg edge on losses: ${stats.avgEdgeOnLosses.toFixed(1)}%`);

const suggestions = suggestAdjustments();
suggestions.forEach(s => console.log(`SUGGESTION: ${s}`));
```

### Approve Tokens for a New Market

```bash
npx tsx src/index.ts approve my-market-slug
```

### Search for Markets by Keyword

```typescript
const limitless = new LimitlessClient();
const btcMarkets = await limitless.searchMarkets('BTC', { limit: 20 });
console.log(btcMarkets.map(m => `${m.slug}: YES=${m.prices[0]}¢ NO=${m.prices[1]}¢`));
```

### Get Orderbook Depth

```typescript
const limitless = new LimitlessClient();
const book = await limitless.getOrderbook('btc-above-100000-mar-1');
console.log('Best bid:', book.bids[0]);
console.log('Best ask:', book.asks[0]);
console.log('Midpoint:', book.midpoint);
```

---

## 14. Agent Integration Patterns

This skill is designed for AI agents operating through OpenClaw. Here are specific patterns for autonomous operation:

### Pattern 1: Setup from Scratch

```typescript
// Clone and setup
await exec('git clone https://github.com/limitless-labs-group/agents-starter.git ~/limitless-trader');
await exec('cd ~/limitless-trader && npm install');

// Create .env
await writeFile('~/limitless-trader/.env', `
PRIVATE_KEY=${walletPrivateKey}
LIMITLESS_API_KEY=${apiKey}
DRY_RUN=true
ORACLE_BET_SIZE=2
`);

// Verify setup
const { stdout } = await exec('cd ~/limitless-trader && npm run iterate');
console.log(stdout); // Should show wallet balance
```

### Pattern 2: Continuous Monitoring Loop

```typescript
// This would run in a heartbeat or cron
async function tradingHeartbeat() {
  // Check if strategy is running
  const { stdout: pm2Status } = await exec('pm2 status oracle-live');
  
  if (!pm2Status.includes('online')) {
    // Restart if crashed
    await exec('cd ~/limitless-trader && pm2 start --name oracle-live "npx tsx src/strategies/oracle-arb/run.ts"');
    notify('Strategy restarted');
  }
  
  // Check for claimable winnings
  const { stdout: claimable } = await exec('cd ~/limitless-trader && npx tsx src/core/limitless/redeem.ts claim-all --dry-run');
  if (claimable.includes('Found')) {
    await exec('cd ~/limitless-trader && npx tsx src/core/limitless/redeem.ts claim-all');
    notify('Winnings claimed');
  }
  
  // Read recent trades
  const trades = await readFile('~/limitless-trader/data/oracle-arb-trades.jsonl', 'utf8');
  const recentTrades = trades.split('\n').filter(Boolean).slice(-10);
  
  // Analyze performance
  const successRate = recentTrades.filter(t => JSON.parse(t).success).length / recentTrades.length;
  if (successRate < 0.5 && recentTrades.length > 5) {
    notify(`Warning: Recent success rate is ${(successRate * 100).toFixed(0)}%`);
  }
}
```

### Pattern 3: Parameter Optimization

```typescript
// Read trade history
const trades = await readFile('~/limitless-trader/data/oracle-arb-trades.jsonl', 'utf8')
  .then(content => content.split('\n').filter(Boolean).map(JSON.parse));

// Analyze by edge threshold
const byEdge = trades.reduce((acc, t) => {
  const edgeBracket = Math.floor(t.edge * 100 / 5) * 5; // 5% buckets
  if (!acc[edgeBracket]) acc[edgeBracket] = { total: 0, success: 0 };
  acc[edgeBracket].total++;
  if (t.success) acc[edgeBracket].success++;
  return acc;
}, {});

// Find optimal threshold
const optimal = Object.entries(byEdge)
  .filter(([_, data]: [string, any]) => data.total >= 3) // Min sample size
  .sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))[0];

console.log(`Optimal edge threshold: ${optimal[0]}% with ${(optimal[1].success/optimal[1].total*100).toFixed(0)}% success rate`);

// Update config if significantly different
if (parseInt(optimal[0]) > 20) {
  const env = await readFile('~/limitless-trader/.env', 'utf8');
  await writeFile('~/limitless-trader/.env', env.replace(/ORACLE_MIN_EDGE=.*/, `ORACLE_MIN_EDGE=${parseInt(optimal[0])/100}`));
  await exec('pm2 restart oracle-live');
}
```

### Pattern 4: Emergency Shutdown

```typescript
async function emergencyShutdown() {
  // Stop trading immediately
  await exec('pm2 stop oracle-live');
  
  // Cancel all open orders
  const dashboard = await fetch('http://localhost:3003/api/dashboard').then(r => r.json());
  for (const order of dashboard.orders || []) {
    // Cancel order via API
    await trading.cancelOrder(order.marketSlug, order.id);
  }
  
  // Claim any winnings
  await exec('cd ~/limitless-trader && npx tsx src/core/limitless/redeem.ts claim-all');
  
  // Generate final report
  const finalBalance = await checkWalletBalance();
  const pnl = finalBalance - startingBalance;
  notify(`Trading stopped. Final P&L: $${pnl.toFixed(2)}`);
}
```

### Pattern 5: Multi-Strategy Deployment

```typescript
// Deploy different strategies with different parameters
const strategies = [
  { name: 'oracle-arb-conservative', edge: 0.20, price: 0.60, size: 1 },
  { name: 'oracle-arb-aggressive', edge: 0.10, price: 0.75, size: 2 },
];

for (const strat of strategies) {
  const env = baseEnv + `
ORACLE_MIN_EDGE=${strat.edge}
ORACLE_MAX_PRICE=${strat.price}
ORACLE_BET_SIZE=${strat.size}
  `;
  
  await writeFile(`~/limitless-trader/.env.${strat.name}`, env);
  await exec(`cd ~/limitless-trader && PORT=${3000 + i} pm2 start --name ${strat.name} "npx tsx src/strategies/oracle-arb/run.ts" -- --env .env.${strat.name}`);
}

// Monitor and compare performance
setInterval(async () => {
  for (const strat of strategies) {
    const data = await fetch(`http://localhost:${3000 + i}/api/dashboard`).then(r => r.json());
    console.log(`${strat.name}: ${data.overview.pnl} P&L, ${data.overview.winRate}% WR`);
  }
}, 60000);
```

---

## 15. Troubleshooting

### Order Rejected: Insufficient Balance

**Symptom:** `Order submission failed: 400 Insufficient balance`

**Fix:**
1. Check USDC balance: your wallet needs enough USDC to cover `makerAmount`
2. Check if balance is locked in other open orders
3. Fund your wallet with more USDC on Base

### Order Rejected: Not Approved

**Symptom:** `Order submission failed: 400 Not approved` or order silently fails

**Fix:**
```bash
npx tsx src/index.ts approve <market-slug>
```

This approves both USDC and CTF for the market's venue contracts.

### Order Rejected: Bad Signature

**Symptom:** `Order submission failed: 400 Invalid signature`

**Possible causes:**
1. Wrong `verifyingContract` — make sure you're using `market.venue.exchange`, not a hardcoded address
2. Incorrect `chainId` — must be `8453` for Base
3. Amount overflow — ensure `makerAmount` and `takerAmount` fit in uint256
4. Tick alignment — `takerAmount` must be a multiple of 1000

> 📖 **MCP checkpoint:** Query: `SearchLimitlessExchange("invalid signature order signing troubleshoot")`

### Market Not Found

**Symptom:** `Failed to fetch market <slug>: 404`

**Fix:**
1. Check the slug is correct — use `getSlugs()` to list all active slugs
2. The market may have been resolved or delisted
3. Slugs are case-sensitive

### Rate Limits

**Symptom:** HTTP 429 responses

**Fix:**
1. Add delays between API calls (the SDK doesn't throttle automatically)
2. Use an API key for higher limits
3. Cache responses where possible (market details, venue data)
4. For CoinGecko, the free tier limits to ~30 req/min — use a demo API key

### WebSocket Disconnection

**Symptom:** Price updates stop arriving

**Fix:**
1. The `LimitlessWebSocket` class auto-reconnects with 1–5s backoff
2. Subscriptions are automatically re-sent on reconnect
3. If disconnections are frequent, check your network or try a different transport
4. Monitor the `disconnect` event for logging

### PRIVATE_KEY Format Error

**Symptom:** `Invalid PRIVATE_KEY format`

**Fix:** The key must be a 0x-prefixed 32-byte hex string, exactly 66 characters:
```
0x + 64 hex characters = 66 chars total
```

### DRY_RUN Not Working

**Symptom:** Orders are being submitted even with `DRY_RUN=true`

**Fix:** Make sure you're using the strategy runner (e.g., `npm run signal-sniper`) which respects the env var, or using the proxy pattern from `run.ts`. Direct `TradingClient.createOrder()` calls also check `process.env.DRY_RUN`.

---

## 15. Links and Resources

### Limitless Exchange
- **App:** [limitless.exchange](https://limitless.exchange)
- **API Docs:** [docs.limitless.exchange](https://docs.limitless.exchange)
- **Docs MCP:** `POST https://docs.limitless.exchange/mcp` — search docs programmatically
- **Python SDK:** [pypi.org/project/limitless-py](https://pypi.org/project/limitless-py/)
- **TypeScript SDK:** [npmjs.com/package/@limitless-exchange/sdk](https://www.npmjs.com/package/@limitless-exchange/sdk)

### Infrastructure
- **Base Chain Explorer:** [basescan.org](https://basescan.org)
- **Base Bridge:** [bridge.base.org](https://bridge.base.org)
- **USDC on Base:** [0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)

### Dependencies
- **viem:** [viem.sh](https://viem.sh) — TypeScript Ethereum library (wallet, signing, contracts)
- **CoinGecko API:** [coingecko.com/api](https://www.coingecko.com/en/api)
- **Socket.IO:** [socket.io](https://socket.io) — WebSocket client for real-time data

### OpenClaw
- **GitHub:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Docs:** OpenClaw AI agent platform for autonomous operation

---

*Built for [OpenClaw](https://github.com/openclaw/openclaw). Query the MCP. Iterate fast. Track everything. Scale winners.*
