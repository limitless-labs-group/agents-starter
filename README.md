# Limitless Agents Starter

Boilerplate for autonomous trading agents on [Limitless Exchange](https://limitless.exchange), the prediction market on Base. TypeScript, built on the official [`@limitless-exchange/sdk`](https://docs.limitless.exchange/developers/sdk/typescript/getting-started), dry-run by default.

Feed [`AGENTS.md`](AGENTS.md) or [`SKILL.md`](SKILL.md) to any coding agent with shell + file access and it handles the rest: setup, trading, iteration.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh
```

One command: checks prerequisites (Node 20+), clones, installs, scaffolds `.env`, and prints exactly which credentials to add. It **never touches a private key**; placing your key stays a step you take yourself. (Prefer to read before running? `curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh -o install.sh && less install.sh && sh install.sh`.)

By hand:

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
npm run init        # creates .env (mode 600), lists the credentials to add
```

## Credentials

Two things go in `.env`. [`npm run doctor`](#doctor) verifies both before you trade.

| Variable | What | Where |
|---|---|---|
| `PRIVATE_KEY` | A **dedicated** trading wallet on Base. Never your main wallet. | Export from your wallet app |
| `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET` | Limitless scoped HMAC token | [limitless.exchange](https://limitless.exchange) → connect the **same** wallet → API token modal → **API Tokens** → Derive |

Fund the wallet with **USDC on Base** (order collateral) and a little **ETH on Base** (gas for approvals and redemptions only; orders themselves are off-chain). There is no testnet or sandbox; rehearse with small live orders.

> **Trading-wallet mode.** While connected in the app, decline the one-time "1-click trading" (smart wallet) prompt. Accepting it puts the profile in `smartWallet` mode and every order your bot signs is rejected with *Signer does not match*. Already accepted? `npm start wallet-mode eoa` switches it back. `npm run doctor` catches this.

## Doctor

```bash
npm run doctor                     # key · token · wallet mode · USDC/ETH balances
npm run doctor -- --market <slug>  # + USDC/CTF approvals for that market's exchange
```

Non-zero exit on anything that would make orders fail. Run it after any credential change.

## Strategies

Every strategy defaults to `DRY_RUN=true`: every order intent is logged, nothing is signed or sent. Flip `DRY_RUN=false` only after a clean dry run.

| Strategy | Run | What it does | Needs |
|---|---|---|---|
| **Template** | `npm run template` | Bare skeleton: scan → fair value → decide. Copy it to build your own. | Base only |
| Certainty Closer | `npm run certainty-closer` | Buy near-resolution favourites, sized by fractional Kelly. The simplest worked example ([guide](src/strategies/certainty-closer/QUICKSTART.md)). | Base only |
| Oracle Arb | `npm run oracle-arb` | Pyth (Hermes SSE) oracle vs Limitless price; fires FOK when the market is mispriced ([guide](src/strategies/oracle-arb/QUICKSTART.md)). | Base only |
| Cross-market MM | `npm run cross-market-mm` | Quote on Limitless, hedge fills on Polymarket, stay delta-neutral. Earns spread + LP rewards ([guide](src/strategies/cross-market-mm/QUICKSTART.md)). | Base + Polygon, guided `cross-market-mm:init` |

Claim winnings from resolved markets any time (standard and neg-risk markets):

```bash
npm run redeem claim-all
```

## Build your own strategy

Copy [`src/strategies/template/`](src/strategies/template/), rename, and replace `fairValue()` with your signal. A strategy is four methods on [`BaseStrategy`](src/strategies/base-strategy.ts):

```typescript
class MyStrategy extends BaseStrategy {
  async initialize() {}                       // connect feeds, load state
  async tick(): Promise<TradeDecision[]> {    // read markets, decide
    return [{ action: 'BUY', marketSlug, side: 'YES', amountUsd: 2, priceLimit: 55, orderType: 'FOK', reason }];
  }
  async shutdown() {}                         // cancel quotes, close feeds
  getStats() { /* for heartbeats */ }
}
```

The base class runs the loop, gates on `DRY_RUN`, routes BUY/SELL to the SDK, and (with `awaitFills = true`) waits out the **taker delay** on markets that hold marketable orders for a moment before matching. Add a `run.ts` and an npm script; `npm run template` is the reference.

Building blocks in [`src/core/`](src/core/):

| Module | Purpose |
|---|---|
| `limitless/client.ts` | One place that turns env into SDK clients (HMAC-first auth) |
| `limitless/markets.ts` | Active markets, search, detail, orderbook |
| `limitless/sdk-trading.ts` | Orders: BUY/SELL, cancel, cancel-replace, `status/batch`, `awaitFill` (taker-delay aware) |
| `limitless/websocket.ts` | Live orderbooks (with initial snapshot) and your order events |
| `limitless/portfolio.ts` | Profile, positions, fill verification, trading-wallet mode |
| `limitless/execution.ts` | The `settlementStatus` state machine: filled / resting / pending / killed |
| `limitless/redeem.ts` | Claim winnings on-chain (CTF and neg-risk adapter) |
| `limitless/approve.ts` | USDC + CTF approvals for a market's exchange |
| `kelly.ts` | Fractional-Kelly sizing |
| `price-feeds/hermes.ts` | Pyth oracle prices over SSE |
| `polymarket/` | Polymarket CLOB v2 adapter + websocket (cross-market-mm hedge leg) |

Two runnable examples: `npm run example:place-order` (search → post-only GTC → watch order events → verify → cancel) and `npm run example:stream` (live orderbooks + your order events).

## For AI agents

This repo carries its own operating contract. Point your agent at [`AGENTS.md`](AGENTS.md) (Claude Code reads it automatically); it routes to [`SKILL.md`](SKILL.md) for the full manual: market structure, SDK reference, websocket semantics, fees, partner flows, and known footguns.

The human handles the one thing the agent must not: placing the private key and token in `.env` and funding the wallet. **Keep secrets out of the agent's chat context**; `init` and `doctor` are built to never print them.

Two other ways to put an agent on Limitless, for different jobs:

- **Chat, with a human approving each order:** the official trading MCP server at `https://api.limitless.exchange/mcp` ([guide](https://docs.limitless.exchange/developers/mcp-server)). The [`mcp-skills/`](mcp-skills/) pack in this repo gives Claude research, sizing, LP-ladder, and portfolio-review skills on top of it. No keys, no server.
- **Unattended bots:** this repo.

Before letting any agent trade, read [Responsible agents](https://docs.limitless.exchange/developers/responsible-agents): self-trade prevention, blocklists, and what gets an address blocked (never cancel CLOB orders on-chain).

## Docs and support

- [Build a trading agent](https://docs.limitless.exchange/developers/build-a-trading-agent), the companion guide for this repo
- [Developer docs](https://docs.limitless.exchange/developers/introduction): [authentication](https://docs.limitless.exchange/developers/authentication), [EIP-712 signing](https://docs.limitless.exchange/developers/eip712-signing), [WebSocket](https://docs.limitless.exchange/developers/websocket/overview), [fees](https://docs.limitless.exchange/user-guide/fees), [API reference](https://docs.limitless.exchange/api-reference/introduction)
- Docs MCP for coding agents: `https://docs.limitless.exchange/mcp`
- [Builders Chat](https://t.me/LimitlessBuildersChat) on Telegram
- Related tools: [`limitless-cli`](https://github.com/limitless-labs-group/limitless-cli) (Rust CLI), [`limitless-feeds-cli`](https://github.com/limitless-labs-group/limitless-feeds-cli) (price-feed mapping), the [Python](https://github.com/limitless-labs-group/limitless-sdk) / [Go](https://github.com/limitless-labs-group/limitless-exchange-go-sdk) / [Rust](https://github.com/limitless-labs-group/limitless-exchange-rust-sdk) SDKs

## Contracts (Base)

| Contract | Address |
|----------|---------|
| CTF | `0xC9c98965297Bc527861c898329Ee280632B76e18` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Exchange and neg-risk adapter addresses are per market: read them from `market.venue`, never hardcode.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, no network
npm run build
```

CI runs all three on Node 20 and 22. `tests/unit/sdk-surface.test.ts` and `tests/unit/sdk-signing.test.ts` fail loudly if an SDK bump changes an API this repo calls or what it signs.

## License

MIT. Real money on real markets; nothing here is financial advice.
