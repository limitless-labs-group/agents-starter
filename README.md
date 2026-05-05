# Limitless Agents Starter

Autonomous trading agents for [Limitless Exchange](https://limitless.exchange), the prediction market on Base.

Built as an [OpenClaw](https://github.com/openclaw/openclaw) skill. Feed `SKILL.md` to your agent and it handles the rest — setup, trading, iteration.

**Docs:** [docs.limitless.exchange](https://docs.limitless.exchange) — API reference, market structure, and guides. Also available as a live MCP server at `https://docs.limitless.exchange/mcp` for AI agents that need up-to-date context.

## For AI Agents

This repo is designed to be operated by AI agents, not just read by humans.

**Quick start with OpenClaw or any coding agent:**

1. Clone this repo
2. Read `SKILL.md` — it contains the full SDK reference, setup guide, and strategy documentation
3. The agent handles: environment setup, wallet configuration, strategy selection, deployment, monitoring, and iteration

The `SKILL.md` acts as a complete operating manual. An agent with file access and a shell can go from zero to live trading by following it.

## For Humans

If you prefer to set things up manually:

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
cp .env.example .env
# Add PRIVATE_KEY and LIMITLESS_API_KEY to .env
```

### Get Your Credentials

**API Key:** [limitless.exchange](https://limitless.exchange) → Connect wallet → Profile → API Keys → Generate

**Private Key:** Export from MetaMask or Rabby. Use a dedicated trading wallet — never your main wallet.

**Funding:** You need USDC (trading collateral) and a small amount of ETH (gas) on Base chain.

### Run a Strategy

```bash
# Dry run (no real trades)
npm run oracle-arb

# Live trading
# Edit .env: DRY_RUN=false
npm run oracle-arb
```

### Dashboard

```bash
npm run dashboard
# Opens at http://localhost:3456
```

### Claim Winnings

```bash
npm run redeem claim-all
```

## Example Strategies

Three strategies are included as starting points. They demonstrate different approaches to finding edge in prediction markets — study them, modify them, or use them as templates for your own.

**Oracle Arb** (`npm run oracle-arb`) — The primary example. Connects to Pyth Hermes SSE for sub-second oracle prices and compares them against Limitless market pricing. When the oracle shows conviction the market hasn't priced in, it fires FOK orders at the actual orderbook ask. Includes orderbook validation, position tracking, and auto-approval.

**Signal Sniper** (`npm run signal-sniper`) — Simpler approach using CoinGecko price data. Finds prediction markets where the current spot price creates an edge against market odds. Good starting point for understanding the strategy framework.

**Cross-Market Arb** (`npm run complement-arb`, also `npm run cross-market-arb`) — Scans for pricing inefficiencies where YES + NO < $1.00. Experimental — demonstrates the complement arbitrage concept. The strategy lives in `src/strategies/cross-market-arb/`; both script names point at the same runner.

**Build your own** — Extend `BaseStrategy` with a `tick()` method that returns trade decisions. The base class handles the execution loop, order submission, and PM2 lifecycle. See `src/strategies/oracle-arb/` for the most complete example.

## Architecture

```
src/
  core/
    limitless/          # Full Limitless API client (markets, trading, signing, redeem)
    price-feeds/        # Pyth Hermes SSE, CoinGecko
  strategies/
    base-strategy.ts    # Strategy base class with tick loop
    oracle-arb/         # Oracle arbitrage strategy
    signal-sniper/      # CoinGecko momentum strategy
    cross-market-arb/   # Binary complement arb
  dashboard.ts          # Analytics dashboard server
```

## Contracts (Base)

| Contract | Address |
|----------|---------|
| CTF | `0xC9c98965297Bc527861c898329Ee280632B76e18` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Resources

- [Limitless API Docs](https://docs.limitless.exchange)
- [Limitless MCP Server](https://docs.limitless.exchange/mcp) — live docs for AI agents
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent platform
- [SKILL.md](./SKILL.md) — full agent operating manual

## License

MIT
