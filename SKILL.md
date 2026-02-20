# Prediction Market Trading Agent

> An OpenClaw skill for automated prediction market trading on Limitless Exchange.

## What This Does

Trading agent toolkit for Limitless Exchange prediction markets on Base chain. It:

1. **Wires up the venue** — Full Limitless Exchange client (markets, orders, signing, claiming)
2. **Provides reusable workflows** — wallet setup, approvals, EIP-712 signing, auto-redeem
3. **Tracks performance** — every trade is logged with learnings for iteration
4. **Iterates autonomously** — analyze results, adjust params, improve over time
5. **Includes starter strategies** — signal-based trading and complement arbitrage

## Strategies

### 1. Signal Sniper (`signal-sniper`)
Monitors external price feeds (CoinGecko) and compares against Limitless market odds. When the feed says an asset is clearly above/below a strike price but the market hasn't adjusted, take the cheap side.

**Edge:** Price feed showing clear direction while market odds lag.

**Best for:** Short-term crypto price bracket markets (5min–2hr expiry).

### 2. Binary Complement Arb (`cross-market-arb`)
Scans all active markets for YES + NO < $1.00. In a binary market, both outcomes sum to $1 at resolution — buying both sides for less guarantees profit.

**Edge:** Market maker spread inefficiency.

**Best for:** Any binary market with thin liquidity.

## Setup

### Prerequisites
- Node.js 18+
- A wallet with USDC on Base chain
- A Limitless API key from [limitless.exchange](https://limitless.exchange)

### Install
```bash
npm install
cp .env.example .env
# Edit .env with your keys
```

### Configure `.env`
```bash
PRIVATE_KEY=0x...              # Wallet private key (Base chain)
LIMITLESS_API_KEY=lmts_...     # From limitless.exchange
COINGECKO_API_KEY=CG-...       # Optional, for signal-sniper
DRY_RUN=true                   # Start with dry run!
LOG_LEVEL=info
```

## Running

### Quick Start
```bash
# Dry run signal sniper
npm run signal-sniper

# Dry run complement arb
npm run complement-arb

# Analysis & iteration
npm run iterate:analyze
```

### Going Live
```bash
# Edit .env: DRY_RUN=false
# Keep bet sizes small to start
npm run signal-sniper
```

## Autonomous Iteration (OpenClaw)

The `iterate.ts` script is designed to be called by an AI agent (via cron or heartbeat):

```bash
npx tsx src/strategies/iterate.ts report    # Quick status
npx tsx src/strategies/iterate.ts analyze   # Deep analysis + recommendations
npx tsx src/strategies/iterate.ts markets   # Scan current opportunities
```

The agent can:
1. Check wallet balance and trade history
2. Scan markets for opportunities
3. Analyze win/loss patterns by asset, edge size, timing
4. Recommend parameter changes (edge threshold, bet size, assets)
5. Start/stop strategies based on performance

**Key principle:** Start every strategy in dry-run mode. Only go live after validating the edge on paper trades.

## Safety

- **Always start with `DRY_RUN=true`**
- Keep bet sizes small ($0.50–$2) until you have 20+ winning trades
- Set `MAX_TOTAL_EXPOSURE_USD` to limit total risk
- Monitor `learnings.jsonl` — if win rate drops below 50%, investigate
- Use a dedicated trading wallet with limited funds

## Extending

### Add a new strategy
1. Create `src/strategies/my-strategy/index.ts`
2. Extend `BaseStrategy` — implement `initialize()`, `tick()`, `shutdown()`, `getStats()`
3. Register in `src/strategies/index.ts`
4. The iterator will automatically pick up and analyze trade results

### Add a new price feed
1. Create client in `src/core/price-feeds/`
2. Implement `getPrice(pair)` returning a number
3. Use in your strategy's `tick()` method

---

*Built for [OpenClaw](https://github.com/openclaw/openclaw). Iterate fast, track everything, scale winners.*
