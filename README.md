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
# Add PRIVATE_KEY + a Limitless scoped HMAC token (LMTS_TOKEN_ID + LMTS_TOKEN_SECRET) to .env
```

### Get Your Credentials

**HMAC token:** [limitless.exchange](https://limitless.exchange) → Connect wallet → API token modal → "API Tokens" tab → Derive → copy the `tokenId` + `secret` into `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`. (Headless/CI: `npm run derive-token`. A legacy `LIMITLESS_API_KEY` still works if you hold one.)

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

### Claim Winnings

```bash
npm run redeem claim-all
```

## Example Strategies

Three strategies are included, spanning distinct archetypes. Study them, modify them, or use them as templates. All authenticate with the scoped HMAC token (`LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`); all default to `DRY_RUN`.

**Cross-market MM** (`npm run cross-market-mm`) — the flagship. Cross-venue market-making: mirrors Polymarket's live orderbook onto Limitless as resting maker quotes and hedges fills back on Polymarket (FAK) to stay delta-flat. Earns the cross-venue spread plus Limitless [maker rebates](https://docs.limitless.exchange/user-guide/maker-rebates) + [LP rewards](https://docs.limitless.exchange/user-guide/lp-rewards). Start with [`QUICKSTART.md`](src/strategies/cross-market-mm/QUICKSTART.md) (dry-run, no money) or the canonical [`SKILL.md`](src/strategies/cross-market-mm/SKILL.md).

**Oracle Arb** (`npm run oracle-arb`) — connects to Pyth Hermes SSE for sub-second oracle prices and compares them against Limitless market pricing. When the oracle shows conviction the market hasn't priced in, it fires FOK orders at the actual orderbook ask. The price-feed / edge-detection archetype.

**Certainty Closer** (`npm run certainty-closer`) — the simplest on-ramp: SDK-only (no external feeds). Filters markets near resolution and buys the favourite, sized via fractional Kelly (`src/core/kelly.ts`). Honestly framed — on its own it has no independent edge; it teaches market-filtering + the `BaseStrategy` loop + disciplined sizing.

**Build your own** — Extend `BaseStrategy` with a `tick()` method that returns trade decisions. The base class handles the execution loop and order submission. See `src/strategies/certainty-closer/` for the simplest example.

## Architecture

```
src/
  core/
    limitless/          # Full Limitless API client (markets, trading, signing, redeem)
    polymarket/         # Polymarket clob-client-v2 adapter + WS (cross-market-mm hedge side)
    price-feeds/        # Pyth Hermes SSE
    kelly.ts            # Fractional-Kelly position sizing util
  strategies/
    base-strategy.ts    # Strategy base class with tick loop
    cross-market-mm/         # Cross-venue market-making (Polymarket ↔ Limitless) — flagship
    oracle-arb/         # Pyth oracle edge-detection
    certainty-closer/   # SDK-only near-resolution example
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
