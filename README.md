# Limitless Agents Starter

Autonomous trading agents for [Limitless Exchange](https://limitless.exchange), the prediction market on Base.

Built as an [OpenClaw](https://github.com/openclaw/openclaw) skill. Feed `SKILL.md` to your agent and it handles the rest — setup, trading, iteration.

**Docs:** [docs.limitless.exchange](https://docs.limitless.exchange) — API reference, market structure, and guides. Also available as a live MCP server at `https://docs.limitless.exchange/mcp` for AI agents that need up-to-date context.

## Strategies

| Strategy | Run | What it does | Guides |
|---|---|---|---|
| **Cross-market MM** &nbsp;*(flagship)* | `npm run cross-market-mm` | Quote on Limitless, hedge fills on Polymarket → delta-neutral. Earns the cross-venue spread + Limitless maker rebates / LP rewards. | [QUICKSTART](src/strategies/cross-market-mm/QUICKSTART.md) · [GO-LIVE](src/strategies/cross-market-mm/GO-LIVE.md) · [SKILL](src/strategies/cross-market-mm/SKILL.md) · [DEMO](src/strategies/cross-market-mm/DEMO.md) |
| Oracle Arb | `npm run oracle-arb` | Pyth (Hermes SSE) oracle vs Limitless pricing; fires FOK when the market is mispriced. | [`src/strategies/oracle-arb/`](src/strategies/oracle-arb/) |
| Certainty Closer | `npm run certainty-closer` | SDK-only, no feeds: buy near-resolution favourites, sized via fractional Kelly. The simplest example. | [`src/strategies/certainty-closer/`](src/strategies/certainty-closer/) |

All three default to `DRY_RUN` (logs intents, signs nothing). **New here?** Start with the flagship's **[QUICKSTART](src/strategies/cross-market-mm/QUICKSTART.md)** — see cross-venue market-making in <10 min with no real money.

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

Pick one from the [Strategies](#strategies) table. They all default to `DRY_RUN`:

```bash
# Flagship — cross-venue market making (dry-run by default)
npm run cross-market-mm
# or the simplest example: npm run certainty-closer

# Go live: set DRY_RUN=false in .env (or dry_run: false in the YAML for cross-market-mm)
```

For the flagship's full lifecycle (find-pairs → preflight → run → status → close), follow [`src/strategies/cross-market-mm/SKILL.md`](src/strategies/cross-market-mm/SKILL.md).

### Claim Winnings

```bash
npm run redeem claim-all
```

## Build your own strategy

`oracle-arb` and `certainty-closer` extend `BaseStrategy` (`src/strategies/base-strategy.ts`): implement `tick()` to return `TradeDecision[]`, plus `initialize()`/`shutdown()`; the base class runs the loop and gates on `DRY_RUN`. `src/strategies/certainty-closer/` is the simplest template. (The flagship `cross-market-mm` has its own runtime loop rather than `BaseStrategy`.)

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
