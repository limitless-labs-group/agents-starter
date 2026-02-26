# Limitless Agents Starter

Autonomous trading agents for [Limitless Exchange](https://limitless.exchange), the prediction market on Base.

Built as an [OpenClaw](https://github.com/openclaw/openclaw) skill. Feed `SKILL.md` to your agent and it handles the rest — setup, trading, iteration.

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

## Strategies

**Oracle Arb** — Uses Pyth Hermes SSE for sub-second oracle prices. Scans short-term crypto prediction markets and fires FOK orders when the oracle shows conviction the market hasn't priced in. Checks actual orderbook ask price before ordering — only trades when there's real edge at the fill price.

**Signal Sniper** — Trades on CoinGecko momentum signals against prediction market pricing.

**Binary Complement Arb** — Finds markets where YES + NO < $1.00 for guaranteed profit.

**Build your own** — Extend `BaseStrategy` with a `tick()` method. See `src/strategies/oracle-arb/` for a complete example.

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
