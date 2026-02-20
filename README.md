# Limitless Agents Starter Kit

Build autonomous trading agents for [Limitless Exchange](https://limitless.exchange) — the #1 prediction market on Base.

## What's Inside

**Core SDK** — Full TypeScript client for the Limitless API
- Market discovery & orderbook
- Order creation with EIP-712 signing
- Position management & P&L tracking
- Auto-redeem winnings from resolved markets
- Real-time WebSocket data

**Strategies** — Starting points for your own trading logic
- Signal Sniper — trade on CoinGecko momentum signals
- Cross-Market Arb — exploit YES+NO pricing inefficiencies
- Bring your own strategy using the base class

**AI Agent Integration** — Built as an [OpenClaw](https://github.com/openclaw/openclaw) skill
- Install as a skill and let your AI agent research, trade, and iterate
- The iterator analyzes past trades and suggests parameter improvements
- SKILL.md provides the full agent interface

## Quick Start

### 1. Prerequisites
- Node.js 18+
- A wallet with USDC on Base chain
- A Limitless API key

### 2. Get Your API Key
1. Go to [limitless.exchange](https://limitless.exchange)
2. Connect your wallet
3. Profile → API Keys → Generate

### 3. Export Your Private Key
**MetaMask:** Settings → Security → Export Private Key
**Rabby:** Settings → Security → Export Private Key

⚠️ Use a dedicated trading wallet. Never use your main wallet.

### 4. Fund Your Wallet
You need USDC on Base chain. Bridge from Ethereum or buy directly on Base.

### 5. Setup
```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
cp .env.example .env
# Edit .env with your private key + API key
```

### 6. Dry Run (No Real Trades)
```bash
npm run signal-sniper
# Watches markets, finds opportunities, logs what it WOULD trade
```

### 7. Go Live
```bash
# Edit .env: DRY_RUN=false
npm run signal-sniper
```

## Strategies

### Signal Sniper
Monitors CoinGecko prices and finds prediction markets where the current price creates an edge. For example, if BTC is trading at $97,500 and there's a market "BTC above $97,000?" with YES at 60¢, the bot recognizes YES should be closer to 90¢+ and buys.

```bash
npm run signal-sniper
# Configure via env: SNIPER_ASSETS, SNIPER_BET_SIZE, SNIPER_MIN_EDGE
```

### Binary Complement Arb
Scans all markets for pricing inefficiencies where YES + NO < $1.00. In a binary market, buying both sides for less than $1 guarantees profit at resolution.

```bash
npm run complement-arb
# Configure via env: ARB_BET_SIZE, ARB_MIN_SPREAD
```

### Iterator (AI Agent Integration)
Analyzes your trade history, scans markets, and suggests improvements. Designed to be called by an AI agent on a schedule.

```bash
npm run iterate           # Quick status report
npm run iterate:analyze   # Deep analysis + recommendations
npm run iterate:markets   # Scan current opportunities
```

## Building Your Own Strategy

Extend `BaseStrategy`:
```typescript
import { BaseStrategy, TradeDecision } from './strategies/base-strategy.js';

class MyStrategy extends BaseStrategy {
  async initialize(): Promise<void> {
    // Setup logic
  }

  async tick(): Promise<TradeDecision[]> {
    const markets = await this.limitless.getActiveMarkets();
    // Your logic here — return trade decisions
    return [];
  }

  async shutdown(): Promise<void> {
    // Cleanup
  }

  getStats() {
    return { activePositions: 0, totalVolumeUsd: 0, pnlUsd: 0, lastTickDurationMs: 0 };
  }
}
```

See `src/strategies/signal-sniper/` for a complete example.

## Architecture

```
src/
├── core/
│   ├── wallet.ts                  # Private key → viem wallet
│   ├── limitless/
│   │   ├── types.ts               # Type definitions
│   │   ├── markets.ts             # Market discovery & search
│   │   ├── trading.ts             # Order creation & submission
│   │   ├── sign.ts                # EIP-712 order signing
│   │   ├── approve.ts             # USDC + CTF token approvals
│   │   ├── redeem.ts              # Claim winnings from resolved markets
│   │   ├── portfolio.ts           # Position & P&L tracking
│   │   └── websocket.ts           # Real-time price data
│   └── price-feeds/
│       └── coingecko.ts           # CoinGecko price client
├── strategies/
│   ├── base-strategy.ts           # Strategy base class
│   ├── index.ts                   # Strategy registry
│   ├── iterate.ts                 # AI-powered analysis & iteration
│   ├── signal-sniper/             # CoinGecko momentum strategy
│   │   ├── index.ts
│   │   ├── run.ts
│   │   └── learnings.ts
│   └── cross-market-arb/          # Binary complement arb
│       ├── index.ts
│       └── run.ts
└── index.ts                       # CLI entry point
```

## Contracts (Base Chain)

| Contract | Address |
|----------|---------|
| CTF (Conditional Tokens) | `0xC9c98965297Bc527861c898329Ee280632B76e18` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Docs & Resources
- [Limitless API Docs](https://docs.limitless.exchange)
- [Python SDK](https://pypi.org/project/limitless-py/)
- [TypeScript SDK](https://www.npmjs.com/package/@limitless-exchange/sdk)
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent platform

## Safety

- **Always start with DRY_RUN=true**
- Use a dedicated wallet with limited funds
- Set MAX_TOTAL_EXPOSURE_USD conservatively
- The strategies included are starting points — test thoroughly before running with real money

## License
MIT
