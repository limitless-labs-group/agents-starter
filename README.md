# Limitless Agents Starter

Autonomous trading agents for [Limitless Exchange](https://limitless.exchange), the prediction market on Base.

Feed `SKILL.md` to any coding agent with shell + file access and it handles the rest — setup, trading, iteration.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh
```

One command: checks prerequisites, clones the repo, installs, and scaffolds your config — then prints exactly which credentials to add. It **never touches a private key**; placing your key stays a step you take yourself. (Prefer to read before running? `curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh -o install.sh && less install.sh && sh install.sh`.)

Then fill `.env` and run `npm run cross-market-mm:init` again — it derives your Polymarket deposit wallet and prints the exact addresses to fund. Full walkthrough: **[QUICKSTART](src/strategies/cross-market-mm/QUICKSTART.md)**.

**Docs:** [Build a trading agent](https://docs.limitless.exchange/developers/build-a-trading-agent) is the companion guide for this repo on [docs.limitless.exchange](https://docs.limitless.exchange) — alongside the full API reference, market structure, and SDKs. Also available as a live MCP server at `https://docs.limitless.exchange/mcp` for AI agents that need up-to-date context.

## Strategies

| Strategy | Run | What it does | Guides |
|---|---|---|---|
| **Cross-market MM** | `npm run cross-market-mm` | Quote on Limitless, hedge fills on Polymarket → delta-neutral. Earns the cross-venue spread + Limitless maker rebates / LP rewards. | [QUICKSTART](src/strategies/cross-market-mm/QUICKSTART.md) · [SKILL](src/strategies/cross-market-mm/SKILL.md) |
| Oracle Arb | `npm run oracle-arb` | Pyth (Hermes SSE) oracle vs Limitless pricing; fires FOK when the market is mispriced. | [QUICKSTART](src/strategies/oracle-arb/QUICKSTART.md) · [SKILL](src/strategies/oracle-arb/SKILL.md) |
| Certainty Closer | `npm run certainty-closer` | SDK-only, no feeds: buy near-resolution favourites, sized via fractional Kelly. The simplest example. | [QUICKSTART](src/strategies/certainty-closer/QUICKSTART.md) · [SKILL](src/strategies/certainty-closer/SKILL.md) |

All three default to `DRY_RUN` (logs intents, signs nothing) so you can boot them risk-free first. **New here?** Start with **[QUICKSTART](src/strategies/cross-market-mm/QUICKSTART.md)** — it takes you all the way to cross-venue market-making live on both chains in ~20–30 min.

## For AI agents

This repo is designed to be operated by an AI agent. Operating it is two lines — install, then follow the manual:

> Run: `curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh`
> Then read `src/strategies/cross-market-mm/SKILL.md` and follow it.

`SKILL.md` is a complete operating manual: the agent handles scaffolding, strategy selection, deployment, monitoring, and iteration. The human handles the one thing it can't — placing the private key + tokens in `.env` and funding the wallet. **Keep secrets out of the agent's chat context;** the `init` bootstrap is built to never read them.

## Manual setup

The installer above does this for you. To do it by hand instead:

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
npm run cross-market-mm:init   # scaffolds .env + config, lists the credentials to add
```

### Get Your Credentials

**HMAC token:** [limitless.exchange](https://limitless.exchange) → Connect wallet → API token modal → "API Tokens" tab → Derive → copy the `tokenId` + `secret` into `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`. (Headless/CI: `npm run derive-token`. A legacy `LIMITLESS_API_KEY` still works if you hold one.)

**Private Key:** Export from MetaMask or Rabby. Use a dedicated trading wallet — never your main wallet.

**Funding:** You need USDC (trading collateral) and a small amount of ETH (gas) on Base chain.

### Run a Strategy

Pick one from the [Strategies](#strategies) table. They all default to `DRY_RUN`:

```bash
# Cross-venue market making (dry-run by default)
npm run cross-market-mm
# or the simplest example: npm run certainty-closer

# Go live: set DRY_RUN=false in .env (or dry_run: false in the YAML for cross-market-mm)
```

For the full cross-market-mm lifecycle (find-pairs → preflight → run → status → close), follow [`src/strategies/cross-market-mm/SKILL.md`](src/strategies/cross-market-mm/SKILL.md).

### Claim Winnings

```bash
npm run redeem claim-all
```

## Build your own strategy

`oracle-arb` and `certainty-closer` extend `BaseStrategy` (`src/strategies/base-strategy.ts`): implement `tick()` to return `TradeDecision[]`, plus `initialize()`/`shutdown()`; the base class runs the loop and gates on `DRY_RUN`. `src/strategies/certainty-closer/` is the simplest template. (`cross-market-mm` has its own runtime loop rather than `BaseStrategy`.)

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
    cross-market-mm/         # Cross-venue market-making (Polymarket ↔ Limitless)
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
- [SKILL.md](./SKILL.md) — full agent operating manual

## License

MIT
