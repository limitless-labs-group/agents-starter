# Limitless Prediction Market Trading Agent

Operating manual for building and running autonomous trading agents on Limitless Exchange (Base). An agent with shell access and this file can go from zero to a live strategy. `AGENTS.md` is the short contract; this is the depth.

---

## Built on the official Limitless SDK

This repo is **not** a hand-rolled API client. Every Limitless call goes through the official, maintained SDK, so you inherit HMAC request signing, EIP-712 order signing, venue routing, typed wire shapes, and retries:

| Package | Version | Used for |
|-----|---------|----------|
| [`@limitless-exchange/sdk`](https://docs.limitless.exchange/developers/sdk/typescript/getting-started) | `^1.1.0` | All Limitless market data, orders (EIP-712), cancel-replace, portfolio, websocket, API tokens. Wrapped by `src/core/limitless/`. |
| [`@polymarket/clob-client-v2`](https://github.com/Polymarket/clob-client) | `^1.1.0` | Polymarket hedge leg (cross-market-mm only). v2 is required: Polymarket collateral is pUSD on the V2 exchange. |
| `@polymarket/builder-relayer-client` | `^0.0.10` | Gasless Polymarket deposit-wallet deploy + approvals (cross-market-mm setup). |

The SDK sends the `lmts-api-key` / `lmts-timestamp` / `lmts-signature` HMAC headers and signs the EIP-712 order struct; you supply a scoped token + a private key, nothing else. Section 6 documents the thin wrappers this repo adds on top; section 7 is the official SDK quick reference for TypeScript, Python, Go, and Rust.

---

## Quick Start Prompt

Paste this into any coding agent with shell access to go from zero to a dry run. The agent clones the repo, reads this file, and handles the rest.

```
Clone https://github.com/limitless-labs-group/agents-starter.git. Your operating contract is AGENTS.md and your manual is SKILL.md; read both before doing anything else.

Run `npm install && npm run init`, then ask me to put these in .env myself (never paste them to you):
→ PRIVATE_KEY — a dedicated trading wallet on Base (never my main wallet)
→ LMTS_TOKEN_ID + LMTS_TOKEN_SECRET — Limitless scoped HMAC token (limitless.exchange → connect the same wallet → API token modal → API Tokens → Derive)

Once I say they are in place: run `npm run doctor` and fix what it flags, dry-run `npm run certainty-closer` (SDK-only, no extra setup), then walk me through the strategies so I can pick one or build my own from `src/strategies/template/`. For cross-market-mm, read src/strategies/cross-market-mm/SKILL.md for its full lifecycle.

Keep me posted. Stay in DRY_RUN until I say otherwise.
```

---

## Setup

### Step 1: Clone and install

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
npm run init          # creates .env from .env.example (mode 600), lists the credentials to add
```

Node 20+ is required. The one-line installer (`curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh`) does the same.

### Step 2: Credentials (scoped HMAC token)

Set in `.env`:

```
PRIVATE_KEY=0x...           # Base chain wallet private key (dedicated trading wallet)
LMTS_TOKEN_ID=...           # Limitless scoped HMAC token id
LMTS_TOKEN_SECRET=...       # Limitless scoped HMAC token secret (base64)
```

Limitless authenticates with **scoped HMAC tokens**. Get yours from the UI: **limitless.exchange → connect the same wallet as `PRIVATE_KEY` → API token modal → "API Tokens" tab → Derive → copy the tokenId + secret.** The browser handles the login session, so you never touch a Privy token. (Headless/CI: `npm run derive-token`. A legacy `LIMITLESS_API_KEY` still works as a fallback if you already hold one.) See [Authentication](https://docs.limitless.exchange/developers/authentication).

While connected in the app, **decline the one-time "1-click trading" (smart wallet) prompt**. Accepting it puts the profile in `smartWallet` mode and every self-signed order is rejected with `Signer does not match - you should use embedded address for smart wallet`. Already accepted? `npm start wallet-mode eoa` switches back (section 22).

The wallet needs USDC (collateral) + a little ETH (gas for approvals and redemptions, ~$1) on Base. There is no testnet or sandbox; all integrations run against production.

### Step 3: Doctor

```bash
npm run doctor                        # key · token · wallet mode · balances
npm run doctor -- --market <slug>     # + approvals for that market's exchange
```

Non-zero exit if orders would be rejected. It never prints a secret.

### Step 4: Dry run

Always start in `DRY_RUN` (the default): every order intent is logged, nothing is signed or sent.

```bash
npm run certainty-closer        # simplest: SDK-only, no extra setup
```

Confirm markets are scanned and `[DRY_RUN] would createOrder` lines appear.

### Step 5: Approve a market's exchange (before going live)

Before an order can fill, the market's exchange must be approved to spend your USDC (and CTF tokens, for sells):

```bash
npm start approve <any-active-market-slug>
```

One approval covers every market that shares that exchange. Neg-risk (grouped) markets use a separate exchange and adapter and need their own approve. Costs gas.

### Step 6: Go live

Flip `DRY_RUN=false` in `.env` (or `dry_run: false` in cross-market-mm's YAML), keep sizes small for the first runs, and run your chosen strategy. Claim winnings from resolved markets any time:

```bash
npm run redeem claim-all
```

---

## Strategies

| Strategy | Run | Archetype |
|---|---|---|
| **template** | `npm run template` | Bare skeleton (scan → fair value → decide). Copy it to build your own. Trades nothing until you replace `fairValue()`. |
| certainty-closer | `npm run certainty-closer` | SDK-only: buy near-resolution favourites sized by fractional Kelly. Teaching example; the edge is the one you assert. |
| oracle-arb | `npm run oracle-arb` | Feed-driven: Pyth (Hermes SSE) oracle vs short-dated crypto markets; FOK when the gap clears a threshold. |
| cross-market-mm | `npm run cross-market-mm` | Cross-venue market making: quote on Limitless, hedge on Polymarket, stay delta-neutral. Own manual under `src/strategies/cross-market-mm/`. |

All default to `DRY_RUN`. Each has a `SKILL.md` + `QUICKSTART.md` beside it (template excepted; it is documented inline).

---

## Key Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | The agent operating contract (safety rules, command map, how to read an order result) |
| `src/core/limitless/client.ts` | Env → SDK clients, HMAC-first auth resolution |
| `src/core/limitless/markets.ts` | `LimitlessClient`: active markets, search, detail, orderbook |
| `src/core/limitless/sdk-trading.ts` | `SDKTradingClient`: BUY/SELL, cancel, cancel-replace, `status/batch`, `awaitFill` |
| `src/core/limitless/execution.ts` | `settlementStatus` state machine + fill summaries |
| `src/core/limitless/websocket.ts` | `LimitlessStream`: orderbook snapshots + updates, your order events |
| `src/core/limitless/portfolio.ts` | `PortfolioClient`: profile, positions, fill verification, trading-wallet mode |
| `src/core/limitless/redeem.ts` | `RedeemClient`: claim winnings on-chain (CTF + neg-risk adapter) |
| `src/core/limitless/approve.ts` | USDC + CTF approvals for a market's exchange/adapter |
| `src/core/doctor.ts` | Preflight checks behind `npm run doctor` |
| `src/strategies/base-strategy.ts` | The tick → decide → execute loop |
| `src/strategies/template/` | The skeleton to copy |
| `src/examples/` | `place-order.ts` (order lifecycle), `stream-orderbook.ts` (websocket) |
| `mcp-skills/` | Claude skills for the chat-runtime path over the official trading MCP server |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Live Documentation and MCP servers](#2-live-documentation-and-mcp-servers)
3. [Market Structure](#3-market-structure)
4. [Architecture](#4-architecture)
5. [Setup Guide](#5-setup-guide)
6. [Core Module Reference](#6-core-module-reference)
7. [Official SDK Quick Reference](#7-official-sdk-quick-reference)
8. [Programmatic API & Partner Integration](#8-programmatic-api--partner-integration)
9. [Delegated Orders](#9-delegated-orders)
10. [Server Wallet Redemption & Withdrawal](#10-server-wallet-redemption--withdrawal)
11. [Market Pages & Navigation](#11-market-pages--navigation)
12. [WebSocket Streaming](#12-websocket-streaming)
13. [Order Results, Errors & Retry](#13-order-results-errors--retry)
14. [EIP-712 Signing Deep Dive](#14-eip-712-signing-deep-dive)
15. [Contract Addresses](#15-contract-addresses)
16. [Fees and Taker Delay](#16-fees-and-taker-delay)
17. [Building Your Own Strategy](#17-building-your-own-strategy)
18. [Autonomous Iteration](#18-autonomous-iteration)
19. [Safety, Risk & Market Integrity](#19-safety-risk--market-integrity)
20. [Common Patterns & Recipes](#20-common-patterns--recipes)
21. [Agent Integration Patterns](#21-agent-integration-patterns)
22. [Troubleshooting](#22-troubleshooting)
23. [Links and Resources](#23-links-and-resources)

---

## 1. Overview

### What Are Prediction Markets?

Prediction markets let participants trade on the outcome of future events. Each market poses a binary question ("Will BTC be above $100,000 on March 1?"), and participants buy YES or NO shares. Prices reflect the crowd's probability estimate: a YES share trading at $0.65 implies a 65% chance the event occurs.

When the market resolves, the winning side's shares redeem for $1.00 each and the losing side's for $0.00.

### What Is Limitless Exchange?

Limitless is a non-custodial prediction market exchange on Base (Ethereum L2, chain id 8453):

- **CLOB (Central Limit Order Book)** markets for precise limit orders, plus AMM markets
- **USDC collateral** (6 decimals)
- **EIP-712 signed orders**: orders are off-chain messages, so placing and cancelling costs no gas; settlement is on-chain
- **Scoped API tokens** with HMAC-SHA256 request signing
- Real-time **WebSocket** streams for orderbooks, prices, and your own order events
- An official **MCP server** for chat-driven trading with human approval

### What This Repo Enables

- **Autonomous trading**: strategies that scan markets, decide, and execute, unattended
- **Cross-venue market making**: quote on Limitless and hedge on Polymarket
- **Oracle-driven trading**: stream Pyth prices and trade the gap
- **Safe iteration**: `DRY_RUN` by default, `doctor` preflight, contract tests against the SDK

---

## 2. Live Documentation and MCP servers

Limitless runs two MCP servers. They do different jobs; do not confuse them.

| | Docs MCP | Trading MCP |
|---|---|---|
| Endpoint | `https://docs.limitless.exchange/mcp` | `https://api.limitless.exchange/mcp` |
| Audience | Coding agents that need up-to-date API facts while *writing code* | Chat assistants (Claude, Grok, any MCP client) that research and *propose orders* a human approves |
| Auth | None | OAuth sign-in to a Limitless account, scope `trading` |
| Holds keys? | n/a | No. Non-custodial; every new order is a proposal you approve in the browser. Cancels execute immediately. |
| Docs | this section | https://docs.limitless.exchange/developers/mcp-server |

### Docs MCP: query before you code

The API evolves. **Before implementing any API call, verify it against the live docs.** Treat the live docs as the source of truth over this file.

```
POST https://docs.limitless.exchange/mcp
Content-Type: application/json
Accept: text/event-stream, application/json
```

JSON-RPC 2.0 over SSE. Two tools:

| Tool | Parameter | Use |
|------|-----------|-----|
| `search_limitless_exchange` | `query` (string) | Semantic search across the docs. Broad or conceptual questions ("how to authenticate", "taker delay"). |
| `query_docs_filesystem_limitless_exchange` | `command` (string) | Read-only shell-style query (`rg`, `grep`, `find`, `tree`, `ls`, `cat`, `head`, `jq`) over a virtual filesystem of the `.mdx` pages and OpenAPI specs. Exact keyword matches, walking the tree, reading a full page by path. Stateless across calls. |

```bash
curl -s -X POST "https://docs.limitless.exchange/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_limitless_exchange","arguments":{"query":"how to place an order"}}}'
```

The response is an SSE stream; parse the `data:` lines as JSON and read `result.content[0].text`.

```typescript
async function queryLimitlessDocs(query: string): Promise<string> {
  const res = await fetch('https://docs.limitless.exchange/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_limitless_exchange', arguments: { query } },
    }),
  });
  const text = await res.text();
  for (const line of text.split('\n').filter((l) => l.startsWith('data: '))) {
    try {
      const parsed = JSON.parse(line.slice(6));
      if (parsed.result?.content?.[0]?.text) return parsed.result.content[0].text;
    } catch {}
  }
  return '';
}
```

Make it a reflex: writing a new API integration, debugging a failing call, changing order parameters → query the docs MCP first.

### Trading MCP: the chat runtime

The trading MCP is the other way to put an agent on Limitless. Add `https://api.limitless.exchange/mcp` as a remote MCP server in Claude Desktop / claude.ai / Claude Code (`claude mcp add --transport http limitless https://api.limitless.exchange/mcp`) and sign in. Fifteen tools: market discovery (`search_markets`, `list_markets`, `list_market_categories`, `get_market`, `get_market_group`, `get_orderbook`, `get_market_price_history`), your account (`get_wallet_balance`, `get_positions`, `get_open_orders`, `get_trade_history`), and trading (`place_orders`, `check_order_status`, `cancel_order`, `cancel_all_orders`).

Load-bearing mechanics:

- `place_orders` **never places**. It returns an `approvalUrl`; the user opens it, reviews the exact terms, and submits. Up to 10 orders per approval; a proposal expires after 10 minutes.
- `cancel_order` / `cancel_all_orders` **execute immediately** with no browser step.
- Orders are GTC or FAK, `outcomeIndex` 0 = YES / 1 = NO, price strictly between 0 and 1, and `price × shares ≥ $1`.
- It trades from the account's **Limitless Wallet**; the wallet check runs on every request.

`mcp-skills/` in this repo packages six Claude skills for that runtime (thesis building, scale-in ladders, LP ladders, portfolio review, group scans, and the shared operating manual). See `mcp-skills/README.md`.

---

## 3. Market Structure

### Binary Markets

Every binary market has two outcome tokens:
- **YES token**: pays $1.00 if the event occurs
- **NO token**: pays $1.00 if it does not

Prices are fractions of $1 (or cents). A YES price of 0.65 means the market estimates a 65% probability. At resolution exactly one side pays $1.00.

**One book per market.** The orderbook is the YES token's book. Buying NO at 0.30 is the same order as selling YES at 0.70, so NO interest shows up in the YES asks. Read one book and you have the whole market.

### Trading Venues: CLOB vs AMM

| Feature | CLOB | AMM |
|---------|------|-----|
| Order type | Limit orders (price + size) | Swap against a pool |
| Price discovery | Orderbook bids/asks | Bonding curve |
| Execution | Maker/taker matching, EIP-712 signed | Instant at pool price |
| `tradeType` | `'clob'` | `'amm'` |

This repo trades **CLOB markets**. Grouped multi-outcome events report `tradeType: 'group'` at the group level; each child outcome is its own CLOB market with its own slug.

### NegRisk / Group Markets

Multi-outcome events ("Which candidate wins?") are groups of binary markets sharing collateral through the NegRisk framework:

- Each child market has its own slug, token ids, and orderbook; trade the **child** slug
- The venue includes both an `exchange` and an `adapter` address; approvals must cover both
- Positions are minted under the adapter's wrapped collateral, so redemption goes through `NegRiskAdapter.redeemPositions(conditionId, [yesBalance, noBalance])`, not the plain CTF call. `RedeemClient` handles this.
- Detect: `market.negRiskRequestId` is set and `market.venue.adapter` is non-null

### Position IDs and Token IDs

Each outcome has a uint256 **position id** (token id) identifying an ERC-1155 token in the CTF contract. Markets carry them as `positionIds: [yes, no]` and/or `tokens: { yes, no }` depending on vintage; use `marketTokenIds(market)` from `src/core/limitless/types.ts` rather than reading one shape. Token ids are used for EIP-712 signing (`tokenId`), CTF balance checks, and redemption.

### Collateral

USDC on Base, 6 decimals: 1 USDC = `1_000_000` raw units.

### Market Lifecycle

```
CREATED → FUNDED (trading open) → CLOSED (trading stopped) → RESOLVED (payouts available)
```

`market.status` reflects this. Once resolved, `winningOutcomeIndex` is 0 (YES) or 1 (NO), the CTF `payoutDenominator` becomes > 0, and winning tokens redeem for USDC. Resolution can lag the deadline by a few minutes; a claim that fails right after resolution usually just needs a retry.

### Market Prices Array

`market.prices` is `[YES_price, NO_price]`. The listings report cents (0..100); orderbook levels are fractions (0..1). `toFraction()` in `types.ts` normalizes either. An **empty book reports midpoint 0.5** with null best bid/ask; treat it as "no price", not 50%.

### Per-market settings that change how orders behave

- `metadata.fee: true` → fee-bearing market. Your signed `feeRateBps` must equal your profile's `rank.feeRateBps` (the SDK does this); see section 16.
- `settings.takerDelayMs` (0 = none) → FOK/FAK are held that long before matching; see section 16. Sports markets currently run a delay; read the field per market rather than assuming.
- `settings.minSize` → minimum order size in shares for that market.
- `settings.maxSpread`, `settings.dailyReward` → the LP reward band and budget (`isRewardable`).

---

## 4. Architecture

### Directory Structure

```
src/
├── index.ts                        # CLI: doctor · approve · whoami · wallet-mode
├── core/
│   ├── doctor.ts                   # Preflight checks (pure w.r.t. I/O, tested with fakes)
│   ├── wallet.ts                   # PRIVATE_KEY → viem WalletClient + Account
│   ├── kelly.ts                    # Fractional-Kelly sizing
│   ├── limitless/
│   │   ├── client.ts               # Env → SDK Client / WebSocketClient, HMAC-first auth
│   │   ├── markets.ts              # LimitlessClient (list/search/detail/orderbook)
│   │   ├── sdk-trading.ts          # SDKTradingClient (orders, cancel, cancel-replace, status, awaitFill)
│   │   ├── execution.ts            # settlementStatus → filled/resting/pending/killed/failed
│   │   ├── websocket.ts            # LimitlessStream (orderbooks + order events)
│   │   ├── portfolio.ts            # PortfolioClient (profile, positions, wallet mode)
│   │   ├── redeem.ts               # RedeemClient (CTF + neg-risk claims) + CLI
│   │   ├── approve.ts              # USDC/CTF approvals
│   │   ├── derive-token.ts         # Headless HMAC-token derivation
│   │   └── types.ts                # Shared types + helpers (marketTokenIds, toFraction, takerDelayMs)
│   ├── polymarket/                 # clob-client-v2 adapter + WS (cross-market-mm hedge leg)
│   └── price-feeds/hermes.ts       # Pyth Hermes SSE (oracle-arb)
├── strategies/
│   ├── base-strategy.ts            # tick → decide → execute loop, DRY_RUN gate, taker-delay aware
│   ├── template/                   # copy me
│   ├── certainty-closer/           # SDK-only example (extends BaseStrategy)
│   ├── oracle-arb/                 # Pyth oracle edge-detection (extends BaseStrategy)
│   └── cross-market-mm/            # cross-venue MM (own runtime, SKILL.md, QUICKSTART.md)
├── examples/                       # place-order.ts, stream-orderbook.ts
└── scripts/                        # init.ts, check-balances.ts, check-orderbook.ts, auto-claim.ts
tests/unit/                         # vitest; no network. sdk-surface + sdk-signing guard SDK bumps.
mcp-skills/                         # Claude skills for the trading MCP (chat runtime)
```

### Module Dependency Graph

```
.env ──► client.ts ──► @limitless-exchange/sdk
              │
   ┌──────────┼───────────────┬──────────────┬──────────────┐
   ▼          ▼               ▼              ▼              ▼
markets.ts  sdk-trading.ts  websocket.ts  portfolio.ts   redeem.ts / approve.ts / doctor.ts
   │          │ (execution.ts)
   └────┬─────┘
        ▼
  base-strategy.ts ──► template/ · certainty-closer/ · oracle-arb/
  cross-market-mm/ (own runtime; uses markets.ts + sdk-trading.ts + polymarket/)
```

### Core Concepts

**One SDK client, shared.** `createSdkClient()` resolves auth once; pass the same `Client` to `LimitlessClient`, `SDKTradingClient`, and `PortfolioClient` so they share a connection and credentials.

**Two signatures, two jobs.** The private key signs the *order* (EIP-712, `signatureType 0`). The HMAC token authenticates the *request*. Both must belong to the same account.

**DRY_RUN is a hard gate.** Every write path in `SDKTradingClient` and `RedeemClient` returns before any network call when dry-run is on. Pass the resolved flag explicitly (`dryRun`) so config and env cannot disagree.

**Read the state machine, not `matched`.** `execution.settlementStatus` says what happened to an order; `execution.ts` classifies it.

---

## 5. Setup Guide

### Prerequisites

- **Node.js 20+** (`node --version`)
- **A dedicated wallet with USDC on Base** (never your main wallet)
- **A Limitless scoped HMAC token** (free, from the UI)
- For cross-market-mm only: a Polymarket relayer key + pUSD on Polygon (guided by `cross-market-mm:init`)

### Step 1: Clone & Install

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter
npm install
npm run init
```

### Step 2: Wallet Setup

Create a dedicated trading wallet and export its private key from your wallet app. Fund it on Base:
- **USDC**: order collateral. Bridge via [bridge.base.org](https://bridge.base.org) or buy on a Base DEX.
- **ETH**: a little (~$1) for gas. Only approvals and redemptions are on-chain; orders and cancels are free.

Recommended starting balance: $10–$50 USDC.

### Step 3: Get a scoped HMAC token

1. Go to [limitless.exchange](https://limitless.exchange) and connect the **same wallet** as `PRIVATE_KEY`.
2. Decline the one-time "1-click trading" (smart wallet) prompt if it appears.
3. Open the API token modal → **"API Tokens"** tab → **Derive**.
4. Copy the `tokenId` and `secret` → `LMTS_TOKEN_ID` and `LMTS_TOKEN_SECRET`.

These are long-lived credentials; one-time setup. The `trading` scope is self-serve for everyone; the partner scopes (`account_creation`, `delegated_signing`) are for platforms whose *other users* trade through them (section 8). Solo traders and bot runners do not apply for partner access; the token above is all you need.

Headless / CI: `npm run derive-token` calls the same `POST /auth/api-tokens/derive` with a Privy identity token (see the script header).

### Step 4: Configure Environment

`.env` (created by `init`):

```bash
# ─── REQUIRED ─────────────────────────────────────────────
PRIVATE_KEY=0x...
LMTS_TOKEN_ID=your-token-id
LMTS_TOKEN_SECRET=your-base64-secret

# ─── SAFETY ───────────────────────────────────────────────
DRY_RUN=true                    # ALWAYS start true

# ─── OPTIONAL ─────────────────────────────────────────────
LOG_LEVEL=info
# LIMITLESS_API_URL / LIMITLESS_WS_URL     endpoint overrides (defaults are production)
# LIMITLESS_API_KEY=                        legacy X-API-Key, only if you already hold one

# ─── STRATEGY TUNABLES (all optional) ────────────────────
# template:          TEMPLATE_MIN_EDGE, TEMPLATE_ORDER_USD, TEMPLATE_MAX_POSITIONS, TEMPLATE_MAX_MINUTES
# certainty-closer:  CC_ASSUMED_EDGE, CC_KELLY_FRACTION, CC_MAX_RISK, …
# oracle-arb:        ORACLE_ASSETS, ORACLE_MIN_EDGE, ORACLE_BET_SIZE, …
# cross-market-mm:   cross-market-mm.config.yaml + RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS
```

### Step 5: Doctor

```bash
npm run doctor
```

Checks: key format; auth resolves (HMAC preferred, legacy warns); `DRY_RUN`; `GET /profiles/me` works; the token's account **matches the signing wallet**; trading-wallet mode is `eoa`; USDC/ETH balances. Add `-- --market <slug>` to check approvals for that market's exchange (and neg-risk adapter). Non-zero exit on any critical failure; `-- --json` for machine output.

### Step 6: First Dry Run

```bash
npm run certainty-closer
```

You should see the SDK client initialize, markets get scanned, and `[DRY_RUN] would createOrder` lines.

### Step 7: Market Approval

Limitless settles through the Conditional Tokens Framework. Before trading on a market's exchange, approve it to move your tokens (one-time per exchange):

```bash
npm start approve <market-slug>
```

This sends on-chain approvals for **USDC → exchange** (BUY orders), **CTF → exchange** (SELL orders), and **CTF → adapter** (neg-risk markets). Gas is a few cents on Base. Without it, orders fail with `Insufficient collateral allowance`.

For an unattended bot, handle the allowance error in code: catch it, run `approveMarketVenue(slug)`, retry once (`oracle-arb` does this).

### Step 8: Go Live

```bash
# .env: DRY_RUN=false  (cross-market-mm: dry_run: false in its YAML)
npm run certainty-closer      # keep sizes small ($1–$2 / order) until validated
```

---

## 6. Core Module Reference

All modules live in `src/core/limitless/` and build on the official SDK. Each accepts either an existing SDK `Client` or the same options object (`{ hmacCredentials?, apiKey?, baseURL? }`); with no argument they resolve auth from the environment.

### client.ts

```typescript
import { createSdkClient, createWebSocketClient, resolveAuth, hasAuth } from './core/limitless/client.js';

const sdk = createSdkClient();               // Client: markets, portfolio, pages, apiTokens, partnerAccounts, …
const ws = createWebSocketClient();          // WebSocketClient with HMAC handshake when a token is configured
const auth = resolveAuth();                  // { hmacCredentials } | { apiKey } | {}
```

Auth precedence: explicit `hmacCredentials` → `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET` → explicit `apiKey` → `LIMITLESS_API_KEY`. Public market reads need none.

### LimitlessClient (`markets.ts`)

```typescript
const markets = new LimitlessClient(sdk);

await markets.getActiveMarkets({ tradeType: 'clob', limit: 25, page: 1, sortBy: 'ending_soon' }); // Market[]
await markets.searchMarkets('BTC above', { limit: 20 });                                          // semantic search
await markets.searchHourlyMarkets('BTC');           // recurring price markets expiring within 60 min
await markets.getMarket(slug);                      // Market (SDK typed fetcher), positionIds + tokens normalized
await markets.getOrderbook(slug);                   // OrderBook: bids/asks (price 0..1, size in raw 6-decimal units), adjustedMidpoint, lastTradePrice | null
await markets.getVenue(slug);                       // { exchange, adapter } cached per slug
await markets.getSlugs();                           // all active slugs
```

`getActiveMarkets` mirrors `GET /markets/active` including `tradeType`, `category`, and `automationType` filters (the SDK's typed `getActiveMarkets` exposes only `limit/page/sortBy`). The API caps `limit` at 25; paginate with `page` (1-indexed).

### SDKTradingClient (`sdk-trading.ts`)

```typescript
const trading = new SDKTradingClient({ privateKey, sdk, dryRun });

// BUY a side. FOK spends USD notional; GTC/FAK convert to shares on the 0.001 grid.
const res = await trading.createOrder({ marketSlug, side: 'YES', limitPriceCents: 55, usdAmount: 2, orderType: 'GTC', postOnly: true });

// SELL shares to close (FAK by default). Needs CTF approval for the exchange.
await trading.sellShares({ marketSlug, side: 'YES', shares: 10, limitPriceCents: 60 });

// Atomic cancel + replace of a resting order (one request per re-quote).
await trading.cancelReplace({ orderId, marketSlug, side: 'YES', limitPriceCents: 54, shares: 10, postOnly: true });

// Look up order state; the REST way to observe a delayed or resting order. Max 50 per call.
await trading.getOrderStatuses([{ orderId }]);

// Wait for a terminal state, honoring the taker delay (polls status/batch after eligibleAt).
const summary = await trading.awaitFill(res.order.id, 'FOK', { eligibleAt: res.execution?.eligibleAt });
// summary.state: 'filled' | 'resting' | 'pending' | 'killed' | 'failed' | 'unknown'

await trading.cancelOrder(orderId);
await trading.cancelAll(marketSlug);                 // per market slug; there is no account-wide cancel-all
await trading.cancelAllAndVerify(marketSlug);        // cancel-all + verify the book is clean, with retries
await trading.getPositionTokens(marketSlug);         // { yes, no } shares
await trading.getPositionTokensSettled(marketSlug);  // same, but waits for two agreeing reads
```

Every write returns a dry-run stub before any network call when `dryRun` is true. `createOrder` and `sellShares` return the SDK `OrderResponse`; read `execution.settlementStatus` (section 13).

### execution.ts

```typescript
import { classifyExecution, summarizeExecution, isTerminalState } from './core/limitless/execution.js';

classifyExecution('UNMATCHED', 'GTC');   // 'resting'
classifyExecution('UNMATCHED', 'FOK');   // 'killed'
classifyExecution('DELAYED', 'FAK');     // 'pending'
summarizeExecution(res, 'FOK');          // { state, contracts, usd, avgPrice, effectiveFeeBps, eligibleAt, txHash, reason }
```

`avgPrice = totalsRaw.usdGross / totalsRaw.contractsGross`; `contracts` and `usd` are the net-of-fee figures in human units.

### LimitlessStream (`websocket.ts`)

```typescript
const stream = new LimitlessStream();                // or new LimitlessStream(ws)
await stream.connect();
await stream.subscribeMarkets(['slug-a', 'slug-b']); // replaces the connection's market set; expect one snapshot per slug
await stream.subscribeOrderEvents();                 // HMAC required; your orders across all markets
await stream.subscribePositions();                   // HMAC required

stream.onOrderbook(({ marketSlug, orderbook }) => { /* bids/asks/adjustedMidpoint */ });
stream.onOrderEvent((event) => {
  if (isOmeEvent(event)) { /* PLACEMENT | UPDATE | CANCELLATION | EXECUTION(status FILLED/PARTIALLY_FILLED/KILLED) */ }
  else { /* SETTLEMENT: MATCHED (provisional) → MINED | FAILED, with txHash */ }
});

await stream.addMarkets(['slug-c']);                 // re-emits the full set
await stream.removeMarkets(['slug-a']);              // re-emits the remaining set (there is no per-market unsubscribe)
await stream.disconnect();
```

Semantics in section 12.

### PortfolioClient (`portfolio.ts`)

```typescript
const portfolio = new PortfolioClient(sdk);
await portfolio.getProfile();                        // GET /profiles/me: id, account, tradeWalletOption, rank.feeRateBps, …
await portfolio.getPositions();                      // { clob, amm, group, points, rewards }
await portfolio.getClobPositions();                  // CLOBPosition[]: market, tokensBalance, orders.liveOrders, rewards.isEarning
await portfolio.getHistory(cursor, 20);              // MINED activity, newest first, cursor-paginated
await portfolio.getPositionTokens(slug);             // { yes, no } shares
await portfolio.verifyFill(slug, 'YES');             // { filled, shares } — ground truth for resting fills
await portfolio.getTradeWalletMode();                // 'eoa' | 'smartWallet' | undefined
await portfolio.setTradeWalletMode('eoa');           // PUT /profiles (HMAC); fixes the smartWallet trap
```

### RedeemClient (`redeem.ts`)

```typescript
const redeemer = new RedeemClient(sdk);
await redeemer.findClaimable(slug);                  // ClaimablePosition | null (flags neg-risk with adapter + [yes, no] amounts)
await redeemer.redeemSingle(slug);                   // tx hash | null
await redeemer.claimAll(slugs);                      // { claimed, totalValue, txHashes }
await redeemer.portfolioSlugs();                     // every market in your positions
```

Standard markets: `ConditionalTokens.redeemPositions(USDC, 0x0, conditionId, [indexSet])`. Neg-risk: `NegRiskAdapter.redeemPositions(conditionId, [yesBalance, noBalance])` with a one-time `setApprovalForAll` on the adapter. CLI: `npm run redeem check|claim|claim-many|claim-all`. Respects `DRY_RUN`.

### approve.ts, doctor.ts, wallet.ts, kelly.ts

- `approveMarketVenue(slug)`: max USDC allowance + CTF `setApprovalForAll` for the market's exchange, plus the adapter when present. Skips what is already approved.
- `runDoctor({ marketSlug? })` → `DoctorReport`; `formatDoctorReport()` renders it. Behind `npm run doctor`.
- `getWallet()`: `PRIVATE_KEY` → viem `WalletClient` (+ public actions) and `LocalAccount` on Base.
- `kellySize({ trueProb, price, bankrollUsd, fraction, maxRiskUsd })` → `{ riskUsd, shares, rawKelly, reason }`; returns zero risk when there is no edge.

### Price feed: Pyth Hermes (`price-feeds/hermes.ts`)

`HermesClient.connect(['BTC', 'ETH'])` streams sub-second oracle prices + confidence over SSE and emits `price` events; `getPrice(asset)` returns the latest. Used by `oracle-arb`.

---

## 7. Official SDK Quick Reference

Four official SDKs share one design: a root `Client` composing markets, orders, portfolio, API tokens, partner accounts, delegated orders, and a websocket client. All support both self-signed trading and partner flows.

| SDK | Version | Install | Docs |
|-----|---------|---------|------|
| TypeScript | 1.1.0 | `npm install @limitless-exchange/sdk` | [docs](https://docs.limitless.exchange/developers/sdk/typescript/getting-started) · [GitHub](https://github.com/limitless-labs-group/limitless-exchange-ts-sdk) |
| Python | 1.1.0 | `pip install limitless-sdk` | [docs](https://docs.limitless.exchange/developers/sdk/python/getting-started) · [GitHub](https://github.com/limitless-labs-group/limitless-sdk) |
| Go | v1.1.0 | `go get github.com/limitless-labs-group/limitless-exchange-go-sdk@v1.1.0` | [docs](https://docs.limitless.exchange/developers/sdk/go/getting-started) · [GitHub](https://github.com/limitless-labs-group/limitless-exchange-go-sdk) |
| Rust | 1.1.0 | see repo | [docs](https://docs.limitless.exchange/developers/sdk/rust/getting-started) · [GitHub](https://github.com/limitless-labs-group/limitless-exchange-rust-sdk) |

### Client Initialization (scoped HMAC token)

```typescript
// TypeScript
import { Client } from '@limitless-exchange/sdk';
const client = new Client({
  baseURL: 'https://api.limitless.exchange',
  hmacCredentials: { tokenId: process.env.LMTS_TOKEN_ID!, secret: process.env.LMTS_TOKEN_SECRET! },
});
```

```python
# Python
from limitless_sdk import Client, HMACCredentials
client = Client(
    base_url="https://api.limitless.exchange",
    hmac_credentials=HMACCredentials(token_id="your-token-id", secret="your-base64-secret"),
)
```

```go
// Go
client := limitless.NewClient(
    limitless.WithHMACCredentials(limitless.HMACCredentials{TokenID: "your-token-id", Secret: "your-base64-secret"}),
)
```

With HMAC credentials set, the SDK generates `lmts-api-key`, `lmts-timestamp`, and `lmts-signature` on every request. Do not build the headers by hand. A legacy `apiKey` / `LIMITLESS_API_KEY` is still accepted by every SDK for accounts that hold one.

### What's new in 1.1.0 (TypeScript)

- `OrderResponse.execution` is typed: `settlementStatus` (string, forward-compatible), `eligibleAt` for taker-delayed orders, `feeRateBps` / `effectiveFeeBps`, `totalsRaw`, `txHash`.
- `client.orders`-style order client gains `cancelReplace` / `cancelReplaceBatch` (`POST /orders/cancel-replace[/batch]`), also on `delegatedOrders`.
- `orderEvent` types model the OME `EXECUTION` frame (FAK/FOK terminal, `status` FILLED/PARTIALLY_FILLED/KILLED, string `eventId` `terminal:<orderId>`) and the settlement `MATCHED` frame (`isEstimate: true`, `token`).
- **Type-only breaking changes:** `OmeOrderEvent.price` / `remainingSize` are `number` (the wire always was); `OrderBook.lastTradePrice` is `number | null`.
- Since 1.0.10: `client.portfolio.getProfile()` with no address reads `GET /profiles/me`; `partnerAccounts.listAccounts()`.
- Typed HTTP errors: `APIError` plus `RateLimitError` (429), `AuthenticationError` (401/403), `ValidationError` (400), `ConflictError` (409), `UnprocessableEntityError` (422), `TooEarlyError` (425), `UpstreamUnavailableError` (502/503).

### Fetching Markets

```typescript
// TypeScript
const { data: markets, totalMarketsCount } = await client.markets.getActiveMarkets({ limit: 10, sortBy: 'newest' });
const market = await client.markets.getMarket('btc-100k');
const book = await client.markets.getOrderBook('btc-100k');
```

```python
# Python
markets = await client.markets.get_active_markets()
for market in markets["data"]:
    print(market["title"], market["slug"])
```

```go
// Go
result, err := client.Markets.GetActiveMarkets(ctx, &limitless.ActiveMarketsParams{Limit: 10, Page: 1})
```

### Creating Self-Signed Orders

```typescript
// TypeScript
import { OrderType, Side } from '@limitless-exchange/sdk';
const orders = client.newOrderClient(process.env.PRIVATE_KEY!);

// GTC limit
await orders.createOrder({ marketSlug: 'btc-100k', tokenId: market.tokens.yes, side: Side.BUY, orderType: OrderType.GTC, price: 0.55, size: 10, postOnly: true });
// FOK: spend 10 USDC
await orders.createOrder({ marketSlug: 'btc-100k', tokenId: market.tokens.yes, side: Side.BUY, orderType: OrderType.FOK, makerAmount: 10 });
```

```python
# Python
result = await order_client.create_order(market_slug="btc-100k", token_id=str(market.tokens.yes), side="BUY", price=0.55, size=10.0, order_type="GTC")
```

```go
// Go
result, err := orderClient.CreateOrder(ctx, limitless.CreateOrderParams{
    MarketSlug: "btc-100k", TokenID: market.Tokens.Yes, Side: limitless.SideBuy, OrderType: limitless.OrderTypeGTC,
    Args: limitless.GTCOrderArgs{Price: 0.55, Size: 10.0},
})
```

### Portfolio

```typescript
// TypeScript
const me = await client.portfolio.getProfile();           // GET /profiles/me
const positions = await client.portfolio.getPositions();  // positions.clob, positions.amm, positions.group
const history = await client.portfolio.getUserHistory(undefined, 20);
```

### SDK Services Overview

| Service | TypeScript | Python | Go |
|---------|-----------|--------|-----|
| Markets & orderbook | `client.markets` (`MarketFetcher`) | `client.markets` | `client.Markets` |
| Market pages & navigation | `client.pages` (`MarketPageFetcher`) | `client.pages` | `client.Pages` |
| Self-signed orders | `client.newOrderClient(key)` (`OrderClient`) | `OrderClient` | `OrderClient` |
| Portfolio & positions | `client.portfolio` (`PortfolioFetcher`) | `client.portfolio` | `client.Portfolio` |
| API tokens | `client.apiTokens` | `client.api_tokens` | `client.ApiTokens` |
| Partner accounts | `client.partnerAccounts` | `client.partner_accounts` | `client.PartnerAccounts` |
| Delegated orders | `client.delegatedOrders` | `client.delegated_orders` | `client.DelegatedOrders` |
| Server wallets | `client.serverWallets` | `client.server_wallets` | `client.ServerWallets` |
| WebSocket streaming | `client.newWebSocketClient()` (`WebSocketClient`) | `WebSocketClient` | `WebSocketClient` |

Rust mirrors the same services; see its docs page.

---

## 8. Programmatic API & Partner Integration

The Programmatic API enables **partners and platforms** to build integrations that create and manage user accounts, place orders on behalf of users, and operate with fine-grained access control — all through HMAC-authenticated API tokens with scoped permissions.

> **Building a bot for yourself?** You do not need the Programmatic API. Derive a scoped API token with the `trading` scope and start trading immediately. The Programmatic API is for **platforms and partners** that need to create and manage sub-accounts on behalf of their users.

> **Legacy API keys (`X-API-Key`) are deprecated** and no longer available for new users. All new integrations should use scoped API tokens with HMAC authentication. Existing API keys continue to work but should be migrated to scoped tokens.

### Partner Lifecycle

1. **Bootstrap** — Create a standard Limitless account at [limitless.exchange](https://limitless.exchange). This gives you a `profileId` and wallet address.
2. **Apply** — Submit the [partner application form](https://docs.google.com/forms/d/e/1FAIpQLSd1P4UB1yDcdcxJzRrM7EiwuJKTFpKtqgFGA_ftYbNOLg7lsQ/viewform) with your wallet address. The team enables token management and allowed scopes.
3. **Check capabilities** — Call `GET /auth/api-tokens/capabilities` (Privy auth) to verify which scopes are enabled for your account. Returns `tokenManagementEnabled` and `allowedScopes`.
4. **Derive a scoped token** — Authenticate with Privy and call `POST /auth/api-tokens/derive`.
5. **Create sub-accounts** — Use the token to create server-wallet or EOA sub-accounts.
6. **Trade** — Place orders on behalf of sub-accounts using delegated signing or EOA-signed orders.

### Deriving a Scoped API Token

```typescript
// TypeScript
import { Client } from '@limitless-exchange/sdk';

const client = new Client({ baseURL: 'https://api.limitless.exchange' });

const derived = await client.apiTokens.deriveToken(identityToken, {
  label: 'my-trading-bot',
  scopes: ['trading', 'account_creation', 'delegated_signing'],
});

const scopedClient = new Client({
  baseURL: 'https://api.limitless.exchange',
  hmacCredentials: {
    tokenId: derived.tokenId,
    secret: derived.secret,
  },
});
```

```python
# Python
from limitless_sdk import Client, HMACCredentials, DeriveApiTokenInput

client = Client(base_url="https://api.limitless.exchange")

derived = await client.api_tokens.derive_token(
    identity_token,
    DeriveApiTokenInput(
        label="my-trading-bot",
        scopes=["trading", "account_creation", "delegated_signing"],
    ),
)

scoped_client = Client(
    base_url="https://api.limitless.exchange",
    hmac_credentials=HMACCredentials(
        token_id=derived.token_id,
        secret=derived.secret,
    ),
)
```

```go
// Go
client := limitless.NewClient()

derived, err := client.ApiTokens.DeriveToken(ctx, identityToken, limitless.DeriveApiTokenInput{
    Label:  "my-trading-bot",
    Scopes: []string{"trading", "account_creation", "delegated_signing"},
})

scopedClient := limitless.NewClient(
    limitless.WithHMACCredentials(limitless.HMACCredentials{
        TokenID: derived.TokenID,
        Secret:  derived.Secret,
    }),
)
```

### Scopes

| Scope | Description | Self-service |
|-------|-------------|--------------|
| `trading` | Place and cancel orders. Default scope. Required base for `delegated_signing`. | Yes |
| `account_creation` | Create sub-account profiles linked to the partner. | Yes |
| `delegated_signing` | Server signs orders on behalf of sub-accounts via managed wallets. Must be paired with `trading`. | Yes |
| `withdrawal` | Transfer ERC20 balances from managed server-wallet sub-accounts. | Yes |
| `admin` | Access admin-protected endpoints. | No (admin-provisioned only) |

### Scope Requirements by Operation

| Operation | Required scopes |
|-----------|----------------|
| Place or cancel orders (`POST /orders`) | `trading` |
| Create sub-accounts (`POST /profiles/partner-accounts`) | `account_creation` |
| Create sub-accounts with server wallets | `account_creation` + `delegated_signing` |
| Submit unsigned orders (server signs) | `trading` + `delegated_signing` |
| Redeem resolved positions (`POST /portfolio/redeem`) | `trading` |
| Withdraw funds (`POST /portfolio/withdraw`) | `withdrawal` |

### Creating Sub-Accounts

**Server wallet mode (Web2 partners)** — The server provisions a managed Privy wallet. The partner submits unsigned orders and the server signs them.

```typescript
// TypeScript
const account = await scopedClient.partnerAccounts.createAccount({
  displayName: 'user-alice',
  createServerWallet: true,
});
// account.profileId, account.account (wallet address)
```

```python
# Python
from limitless_sdk import CreatePartnerAccountInput

account = await scoped_client.partner_accounts.create_account(
    CreatePartnerAccountInput(
        display_name="user-alice",
        create_server_wallet=True,
    )
)
```

```go
// Go
createServerWallet := true
account, err := scopedClient.PartnerAccounts.CreateAccount(ctx, limitless.CreatePartnerAccountInput{
    DisplayName:        "user-alice",
    CreateServerWallet: &createServerWallet,
}, nil) // nil = no EOA headers (server wallet mode)
```

**EOA mode (Web3 partners)** — The end user keeps their private key. They sign each order themselves via EIP-712.

```typescript
// TypeScript — EOA registration with wallet ownership proof
const account = await scopedClient.partnerAccounts.createAccount(
  { displayName: 'user-bob' },
  {
    account: userWalletAddress,
    signingMessage: hexEncodedMessage,
    signature: walletSignature,
  },
);
```

### API Token Management

```typescript
// TypeScript — list and revoke tokens
const tokens = await scopedClient.apiTokens.listTokens();
for (const t of tokens) {
  console.log(t.tokenId, t.label, t.scopes, t.lastUsedAt);
}

await scopedClient.apiTokens.revokeToken('token-id-to-revoke');
```

### HMAC Signing Protocol

If you're implementing HMAC auth without the SDK (e.g. in a language without an official SDK), every request must include three headers:

| Header | Value |
|--------|-------|
| `lmts-api-key` | Your `tokenId` |
| `lmts-timestamp` | ISO-8601 timestamp (e.g. `2025-03-15T10:30:00.000Z`) |
| `lmts-signature` | HMAC-SHA256 of the canonical message, base64-encoded |

**Canonical message format:**

```
{ISO-8601 timestamp}\n{HTTP METHOD}\n{request path with query string}\n{request body}
```

- Path must include the **full request path AND query string** (e.g. `/orders/all/btc-100k?onBehalfOf=42`)
- For GET requests, the body component is an empty string
- The secret is base64-decoded before use as the HMAC key

**If using an official SDK:** The SDK handles all of this automatically when you set `hmacCredentials`. Do not manually build HMAC headers.

### Recommended Architecture

- **Store HMAC credentials on your backend.** The `tokenId` and `secret` should never leave your server.
- **Use the SDK server-side** for all trading, account creation, and delegated signing calls.
- **Expose only your own endpoints to the frontend.** Your frontend talks to your backend — your backend talks to the Limitless API.
- **Keep public reads in the browser.** Unauthenticated endpoints (market data, orderbooks) can be called directly.

---

## 9. Delegated Orders

Delegated orders let partners submit **unsigned** orders on behalf of server-wallet sub-accounts. The server signs them automatically using the managed Privy wallet. This requires the `trading` + `delegated_signing` scopes.

**Key detail:** With delegated signing, you omit the `signature` and `signatureType` fields from the order payload entirely — the server populates them using the sub-account's managed wallet. You still provide all other order fields (`tokenId`, `side`, `price`/`size`/`makerAmount`, etc.) but the cryptographic signing is handled server-side.

Three execution strategies are supported:

### GTC (Good-Til-Cancelled)

Limit orders that rest on the orderbook until filled or cancelled.

| Parameter | Description |
|-----------|-------------|
| `price` | Price between 0 and 1 |
| `size` | Number of contracts |
| `postOnly` | Optional. When `true`, rejected if it would immediately match. Default `false`. |

```typescript
// TypeScript
import { OrderType, Side } from '@limitless-exchange/sdk';

const order = await scopedClient.delegatedOrders.createOrder({
  marketSlug: 'btc-100k',
  orderType: OrderType.GTC,
  onBehalfOf: account.profileId,
  args: {
    tokenId: market.tokens.yes,
    side: Side.BUY,
    price: 0.55,
    size: 10,
    postOnly: true,
  },
});
```

```python
# Python
order = await scoped_client.delegated_orders.create_order(
    token_id=str(market.tokens.yes),
    side=Side.BUY,
    order_type=OrderType.GTC,
    market_slug="btc-100k",
    on_behalf_of=account.profile_id,
    price=0.55,
    size=10.0,
)
```

```go
// Go
order, err := scopedClient.DelegatedOrders.CreateOrder(ctx, limitless.CreateDelegatedOrderParams{
    MarketSlug: "btc-100k",
    OrderType:  limitless.OrderTypeGTC,
    OnBehalfOf: account.ProfileID,
    Args: limitless.GTCOrderArgs{
        TokenID:  market.Tokens.Yes,
        Side:     limitless.SideBuy,
        Price:    0.55,
        Size:     10.0,
        PostOnly: true,
    },
})
```

### FAK (Fill-And-Kill)

Limit orders that match immediately available liquidity. Any unmatched remainder is cancelled — nothing rests on the book.

| Parameter | Description |
|-----------|-------------|
| `price` | Price between 0 and 1 |
| `size` | Number of contracts |

```typescript
// TypeScript
const order = await scopedClient.delegatedOrders.createOrder({
  marketSlug: 'btc-100k',
  orderType: OrderType.FAK,
  onBehalfOf: account.profileId,
  args: {
    tokenId: market.tokens.yes,
    side: Side.BUY,
    price: 0.45,
    size: 10,
  },
});

if (order.makerMatches?.length) {
  console.log(`Matched immediately with ${order.makerMatches.length} fill(s)`);
} else {
  console.log('No immediate fill. Remainder was cancelled.');
}
```

```python
# Python
order = await scoped_client.delegated_orders.create_order(
    token_id=str(market.tokens.yes),
    side=Side.BUY,
    order_type=OrderType.FAK,
    market_slug="btc-100k",
    on_behalf_of=account.profile_id,
    price=0.45,
    size=10.0,
)

if order.maker_matches:
    print(f"Matched immediately with {len(order.maker_matches)} fill(s)")
else:
    print("No immediate fill. Remainder was cancelled.")
```

```go
// Go
order, err := scopedClient.DelegatedOrders.CreateOrder(ctx, limitless.CreateDelegatedOrderParams{
    MarketSlug: "btc-100k",
    OrderType:  limitless.OrderTypeFAK,
    OnBehalfOf: account.ProfileID,
    Args: limitless.FAKOrderArgs{
        TokenID: market.Tokens.Yes,
        Side:    limitless.SideBuy,
        Price:   0.45,
        Size:    10.0,
    },
})

if len(order.MakerMatches) > 0 {
    fmt.Printf("Matched immediately with %d fill(s)\n", len(order.MakerMatches))
} else {
    fmt.Println("No immediate fill. Remainder was cancelled.")
}
```

### FOK (Fill-Or-Kill)

Market orders that execute immediately at the best available price or are cancelled entirely — no partial fills. Uses `makerAmount` instead of `price` + `size`.

| Parameter | Description |
|-----------|-------------|
| `makerAmount` | **BUY**: USDC amount to spend. **SELL**: number of shares to sell. |

```typescript
// TypeScript
const order = await scopedClient.delegatedOrders.createOrder({
  marketSlug: 'btc-100k',
  orderType: OrderType.FOK,
  onBehalfOf: account.profileId,
  args: {
    tokenId: market.tokens.yes,
    side: Side.BUY,
    makerAmount: 10, // spend 10 USDC
  },
});
```

```python
# Python
order = await scoped_client.delegated_orders.create_order(
    token_id=str(market.tokens.yes),
    side=Side.BUY,
    order_type=OrderType.FOK,
    market_slug="btc-100k",
    on_behalf_of=account.profile_id,
    maker_amount=10.0,
)
```

```go
// Go
order, err := scopedClient.DelegatedOrders.CreateOrder(ctx, limitless.CreateDelegatedOrderParams{
    MarketSlug: "btc-100k",
    OrderType:  limitless.OrderTypeFOK,
    OnBehalfOf: account.ProfileID,
    Args: limitless.FOKOrderArgs{
        TokenID:     market.Tokens.Yes,
        Side:        limitless.SideBuy,
        MakerAmount: 10.0,
    },
})
```

### Cancelling Delegated Orders

```typescript
// TypeScript — cancel single order on behalf of sub-account
await scopedClient.delegatedOrders.cancelOnBehalfOf(orderId, account.profileId);

// Cancel all orders in a market on behalf of sub-account
await scopedClient.delegatedOrders.cancelAllOnBehalfOf('btc-100k', account.profileId);
```

```python
# Python
await scoped_client.delegated_orders.cancel_on_behalf_of(order_id, account.profile_id)
await scoped_client.delegated_orders.cancel_all_on_behalf_of("btc-100k", account.profile_id)
```

```go
// Go
err = scopedClient.DelegatedOrders.CancelOnBehalfOf(ctx, orderId, account.ProfileID)
err = scopedClient.DelegatedOrders.CancelAllOnBehalfOf(ctx, "btc-100k", account.ProfileID)
```

---

## 10. Server Wallet Redemption & Withdrawal

For server-wallet sub-accounts, **trading**, **market resolution**, and **redemption** are separate stages:

1. **Order execution** — Place and cancel orders through `POST /orders` or the `DelegatedOrderService`.
2. **Portfolio resolution state** — Portfolio endpoints may show `status: RESOLVED` and `winningOutcomeIndex` once the winning side is known.
3. **On-chain payout settlement** — Winning positions become redeemable only after the conditional token payout has been reported on-chain.

> **Important:** `status: RESOLVED` in the portfolio does **not** guarantee that the position is redeemable on-chain. The CTF condition must be settled first (`payoutDenominator(conditionId) > 0`).

### Redeem Resolved Positions

`POST /portfolio/redeem` — Submit `redeemPositions` for a resolved condition.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `conditionId` | Yes | CTF condition ID (bytes32 hex string) |
| `onBehalfOf` | No | Managed sub-account profile ID (partner flow) |

**Auth:** `apiToken` (scope: `trading`), Privy, or session. Legacy API keys are **not** supported for server-wallet operations.

```typescript
// TypeScript
const result = await scopedClient.portfolio.redeem({
  conditionId: '0xabc123...',
  onBehalfOf: account.profileId,
});
```

```python
# Python
result = await scoped_client.portfolio.redeem(
    condition_id="0xabc123...",
    on_behalf_of=account.profile_id,
)
```

```go
// Go
result, err := scopedClient.Portfolio.Redeem(ctx, limitless.RedeemParams{
    ConditionID: "0xabc123...",
    OnBehalfOf:  account.ProfileID,
})
```

### Withdraw Funds

`POST /portfolio/withdraw` — Transfer ERC20 funds from a managed sub-account server wallet to the partner's own account.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `amount` | Yes | Amount to withdraw (human-readable, e.g., `"50"` for 50 USDC) |
| `token` | Yes | Token address (USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| `onBehalfOf` | No | Managed sub-account profile ID |

**Auth:** `apiToken` (scope: `withdrawal`), Privy, or session.

```typescript
// TypeScript
const result = await scopedClient.portfolio.withdraw({
  amount: '50',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  onBehalfOf: account.profileId,
});
```

```python
# Python
result = await scoped_client.portfolio.withdraw(
    amount="50",
    token="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    on_behalf_of=account.profile_id,
)
```

```go
// Go
result, err := scopedClient.Portfolio.Withdraw(ctx, limitless.WithdrawParams{
    Amount:     "50",
    Token:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    OnBehalfOf: account.ProfileID,
})
```

### API Endpoints Summary

| Endpoint | Auth | Scope | Description |
|----------|------|-------|-------------|
| `GET /auth/api-tokens/capabilities` | Privy | — | Check partner capability configuration |
| `POST /auth/api-tokens/derive` | Privy | — | Create a scoped API token |
| `GET /auth/api-tokens` | Any | — | List active tokens |
| `DELETE /auth/api-tokens/{tokenId}` | Any | — | Revoke a token |
| `POST /profiles/partner-accounts` | HMAC | `account_creation` | Create a sub-account |
| `POST /orders` | HMAC | `trading` | Place orders (with optional delegated signing) |
| `POST /portfolio/redeem` | apiToken / Privy / session | `trading` | Redeem resolved positions |
| `POST /portfolio/withdraw` | apiToken / Privy / session | `withdrawal` | Withdraw ERC20 funds |

---

## 11. Market Pages & Navigation

The Market Pages API provides structured browsing of markets by category, with navigation trees, filtering, and pagination. Useful for building UIs or scanning specific market segments programmatically.

### Navigation Tree

```typescript
// TypeScript
import { MarketPageFetcher } from '@limitless-exchange/sdk';

const pageFetcher = new MarketPageFetcher(httpClient);
const navigation = await pageFetcher.getNavigation();

for (const node of navigation) {
  console.log(`${node.name} → ${node.path}`);
  for (const child of node.children) {
    console.log(`  ${child.name} → ${child.path}`);
  }
}
```

```python
# Python
from limitless_sdk.market_pages import MarketPageFetcher

page_fetcher = MarketPageFetcher(http_client)
navigation = await page_fetcher.get_navigation()

for node in navigation:
    print(f"{node.name} → {node.path}")
    for child in node.children:
        print(f"  {child.name} → {child.path}")
```

```go
// Go
pageFetcher := limitless.NewMarketPageFetcher(httpClient)
navigation, err := pageFetcher.GetNavigation(ctx)

for _, node := range navigation {
    fmt.Printf("%s → %s\n", node.Name, node.Path)
}
```

### Browsing Markets by Page

```typescript
// TypeScript — resolve a page by URL path, then fetch its markets
const page = await pageFetcher.getMarketPageByPath('/crypto');

const result = await pageFetcher.getMarkets(page.id, {
  page: 1,
  limit: 20,
  sort: '-updatedAt', // newest first
});

for (const market of result.data) {
  console.log(`${market.slug} — ${market.title}`);
}
```

```python
# Python
page = await page_fetcher.get_market_page_by_path("/crypto")

result = await page_fetcher.get_markets(page.id, {
    "page": 1,
    "limit": 20,
    "sort": "-updatedAt",
})

for market in result.data:
    print(f"{market.slug} — {market.title}")
```

```go
// Go
page, err := pageFetcher.GetMarketPageByPath(ctx, "/crypto")

result, err := pageFetcher.GetMarkets(ctx, page.ID, &limitless.MarketPageMarketsParams{
    Page:  intPtr(1),
    Limit: intPtr(20),
    Sort:  limitless.MarketPageSortNewest,
})

for _, market := range result.Data {
    fmt.Printf("%s — %s\n", market.Slug, market.Title)
}
```

### Filtering Markets

```typescript
// TypeScript — filter by ticker and duration
const result = await pageFetcher.getMarkets(page.id, {
  limit: 10,
  sort: '-updatedAt',
  filters: {
    ticker: ['btc', 'eth'],
    duration: 'hourly',
  },
});
```

```python
# Python
result = await page_fetcher.get_markets(page.id, {
    "limit": 10,
    "sort": "-updatedAt",
    "filters": {
        "ticker": ["btc", "eth"],
        "duration": "hourly",
    },
})
```

```go
// Go
result, err := pageFetcher.GetMarkets(ctx, page.ID, &limitless.MarketPageMarketsParams{
    Limit: intPtr(10),
    Sort:  limitless.MarketPageSortNewest,
    Filters: map[string]any{
        "ticker":   []string{"btc", "eth"},
        "duration": "hourly",
    },
})
```

### Sort Options

| Sort key | Description |
|----------|-------------|
| `createdAt` / `-createdAt` | Creation date (asc/desc) |
| `updatedAt` / `-updatedAt` | Last update |
| `deadline` / `-deadline` | Expiration |
| `id` / `-id` | Market ID |

Prefix with `-` for descending order.

### Cursor Pagination

For large result sets, use cursor-based pagination instead of offset:

```typescript
// TypeScript
const firstPage = await pageFetcher.getMarkets(page.id, { cursor: '', limit: 20 });

if (firstPage.cursor?.nextCursor) {
  const nextPage = await pageFetcher.getMarkets(page.id, {
    cursor: firstPage.cursor.nextCursor,
    limit: 20,
  });
}
```

### Property Keys (Dynamic Filters)

Discover available filter keys and their options:

```typescript
// TypeScript
const keys = await pageFetcher.getPropertyKeys();
for (const key of keys) {
  console.log(`${key.name} (${key.type})`); // e.g. "Ticker (select)"
}

const options = await pageFetcher.getPropertyOptions(keyId);
// options: [{ label: "BTC", value: "btc" }, { label: "ETH", value: "eth" }, ...]
```

---


## 12. WebSocket Streaming

Socket.IO over `wss://ws.limitless.exchange` (namespace `/markets`, websocket transport only). Public channels need no auth; the per-account channels need an HMAC-signed handshake, which the SDK does from `hmacCredentials`. Full reference: [WebSocket overview](https://docs.limitless.exchange/developers/websocket/overview) with one page per subscription.

### Connection

```typescript
// TypeScript (SDK)
import { WebSocketClient } from '@limitless-exchange/sdk';
const ws = new WebSocketClient({
  url: 'wss://ws.limitless.exchange',
  autoReconnect: true,
  hmacCredentials: { tokenId: process.env.LMTS_TOKEN_ID!, secret: process.env.LMTS_TOKEN_SECRET! }, // for order events / positions
});
await ws.connect();
```

In this repo, `LimitlessStream` (section 6) wraps this with the semantics below baked in. Do not send your own PING frames; the server runs the Socket.IO heartbeat.

### Market data: `subscribe_market_prices` → `orderbookUpdate` / `newPriceData`

```typescript
await ws.subscribe('subscribe_market_prices', { marketSlugs: ['btc-100k-weekly'], marketAddresses: ['0x…'] });
ws.on('orderbookUpdate', ({ marketSlug, orderbook }) => { /* bids, asks, adjustedMidpoint, minSize, maxSpread */ });
ws.on('newPriceData', ({ marketAddress, updatedPrices }) => { /* AMM */ });
```

- **Replace semantics.** Every `subscribe_market_prices` call drops the connection's previous market set and joins the new one. Send CLOB slugs and AMM addresses in the same call. To drop one market, re-emit with the smaller set. To stop everything, disconnect.
- **Initial snapshot.** Right after the `system` ack the server pushes one `orderbookUpdate` per CLOB slug with the full current book, empty books included (`bids: []`, `asks: []`). No REST call is needed to seed local state. Unknown or resolved slugs get no snapshot.
- Frames carry a `version` (listener publish sequence; not contiguous per market; `0` for a DB-fallback snapshot). Books are coalesced: a burst of changes can arrive as one frame.

### Order events: `subscribe_order_events` → `orderEvent` (HMAC)

```typescript
await ws.subscribe('subscribe_order_events');          // no payload; per-account, all markets
ws.on('orderEvent', (event) => {
  if (event.source === 'OME') {
    // type: PLACEMENT | UPDATE | CANCELLATION | EXECUTION
    // EXECUTION = FAK/FOK terminal frame with status FILLED | PARTIALLY_FILLED | KILLED
  } else {
    // source SETTLEMENT: type MATCHED (provisional, isEstimate) → MINED | FAILED, with txHash / tradeEventId
  }
});
ws.on('exception', (e) => { /* auth failures land here, not on orderEvent */ });
```

- Discriminate on `source`, then `type`. OME frames are **per change** and never coalesced; persisting them gives a complete record including cancellations, which trade history does not show.
- Ordering across OME and SETTLEMENT is not guaranteed; correlate by `orderId` / `clientOrderId` / `tradeEventId`.
- One subscription per connection; re-emit after every reconnect (the SDK does). Server-side dedup within a 60 s window.
- Events route to the **order owner**. Orders placed for partner sub-accounts go to the sub-account's channel; delegation is REST-only.
- `txHash` is the universal join key across the `POST /orders` response, the `MINED` frame, and `/portfolio/history`.

### Positions, lifecycle, sports

- `subscribe_positions` → `positions` (HMAC): balance updates.
- `subscribe_market_lifecycle` / `unsubscribe_market_lifecycle` → `marketCreated`, `marketResolved` (public). The only channel with a real unsubscribe besides unrealized-PnL.
- `subscribe_live_sports` / `subscribe_live_esports` → `live_sports_update` / `live_esports_update` (public).

### Unsubscribing

There is no generic `unsubscribe` event. `subscribe_market_prices`, `subscribe_positions`, and `subscribe_order_events` replace on re-subscribe; only market lifecycle and unrealized-PnL have explicit unsubscribes. A client that emits an unregistered unsubscribe name waits for an ack that never comes.

### Python / Go

```python
@ws_client.on("connect")
async def on_connect():
    await ws_client.subscribe("subscribe_market_prices", {"marketSlugs": ["btc-100k-weekly"]})

@ws_client.on("orderbookUpdate")
async def on_orderbook(data):
    print(data["marketSlug"], len(data["orderbook"]["bids"]))
```

```go
ws := limitless.NewWebSocketClient(limitless.WithHMACCredentials(creds), limitless.WithAutoReconnect(true))
err := ws.Connect(ctx)
err = ws.Subscribe(ctx, "subscribe_market_prices", limitless.SubscriptionOptions{MarketSlugs: []string{"btc-100k-weekly"}})
ws.OnOrderbookUpdate(func(u limitless.OrderbookUpdate) { fmt.Println(u.MarketSlug, len(u.Orderbook.Bids)) })
```

---

## 13. Order Results, Errors & Retry

### The order result: branch on `settlementStatus`

`POST /orders` returns `{ order, execution, makerMatches? }`. `execution.settlementStatus` is the field to branch on; `execution.matched` is not enough (`matched: false` is `UNMATCHED` *or* `DELAYED` *or* `CANCELED`).

| `settlementStatus` | Meaning | GTC | FOK / FAK |
|---|---|---|---|
| `MINED` / `CONFIRMED` | settled on-chain (`txHash` set) | filled | filled |
| `UNMATCHED` | nothing crossed | **resting** on the book | killed, no position |
| `DELAYED` | held by the taker delay until `eligibleAt` | n/a | pending; not an error |
| `MATCHED` / `RETRYING` | provisional | pending | pending |
| `FAILED` | settlement failed | terminal | terminal |
| `CANCELED` | self-trade prevention rejected it (`reason: STP_TAKER_REJECTED`) | terminal | terminal |

For a non-delayed taker order the request blocks through matching and settlement, so `MINED` in the synchronous response means done. `execution.totalsRaw` (raw 6-decimal integer strings) gives gross/fee/net contracts and USD; average fill price = `usdGross / contractsGross`. `src/core/limitless/execution.ts` encodes all of this.

### Rejections

Rejected orders are an HTTP status plus `{ "message": string }`. **There is no machine-readable error code**, and message strings are not a stable contract. Branch on the status:

| Code | Meaning | Action |
|------|---------|--------|
| `400` | validation (bad signature, wrong `feeRateBps`, size off grid, deadline passed, would cross with postOnly…) | fix the order; do not blacklist the market on normal-flow rejections |
| `401` | HMAC rejected (bad secret, stale timestamp, clock skew) | check the secret and the machine clock |
| `403` | scope / authz (e.g. wallet-mode mismatch, missing scope) | `npm run doctor` |
| `404` | unknown slug | verify the market exists |
| `409` | duplicate (order hash / `clientOrderId`) | idempotent; read status instead of re-sending |
| `425` | outside the recv window, or maintenance mode | retry after the window / when trading resumes |
| `429` | rate limited (edge) | back off; slow the re-quote loop |
| `5xx` | server | retry with backoff |

### Typed errors

```typescript
import { APIError, RateLimitError, AuthenticationError, ValidationError, ConflictError, TooEarlyError } from '@limitless-exchange/sdk';

try {
  await trading.createOrder(/* … */);
} catch (err) {
  if (err instanceof RateLimitError) { /* err.data?.retryAfterSeconds */ }
  else if (err instanceof AuthenticationError) { /* 401/403 */ }
  else if (err instanceof APIError) { console.log(err.status, err.message); }
  else throw err;
}
```

Python: `from limitless_sdk.api import APIError` (`e.status_code`, `e.message`). Go: `errors.As(err, &apiErr)` with `*limitless.APIError`, plus `ValidationError`, `AuthenticationError`, `RateLimitError`, `OrderValidationError`.

### Retry

```typescript
// TypeScript
import { withRetry } from '@limitless-exchange/sdk';
await withRetry(() => client.markets.getMarket(slug), { statusCodes: [429, 500, 502, 503, 504], maxRetries: 3, delays: [1000, 2000, 4000] });
```

Never blind-retry a `POST /orders` that timed out without first reading its status (`getOrderStatuses` by `orderId`/`clientOrderId`): it may have filled. For quoting loops prefer `cancelReplace` over cancel + create, and keep a minimum interval between re-quotes.

---

## 14. EIP-712 Signing Deep Dive

Every CLOB order is an EIP-712 signature; the exchange verifies it off-chain and settles on-chain. **The SDK does this for you.** This section exists so you can recognise a wrong signature when you see one. Reference: [EIP-712 signing](https://docs.limitless.exchange/developers/eip712-signing).

### The Domain

```typescript
const domain = {
  name: 'Limitless CTF Exchange',
  version: '1',
  chainId: 8453,
  verifyingContract: market.venue.exchange, // per market: default CTF exchange vs neg-risk exchange
};
```

### The Order Struct

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
  ],
};
```

`tests/unit/sdk-signing.test.ts` re-derives a signature from this exact struct with viem and asserts the SDK produces the same bytes.

### Field-by-Field

| Field | Rule |
|-------|------|
| `salt` | unique per order |
| `maker` | your trading wallet, EIP-55 checksummed. Must match the profile's trading wallet for its mode (`eoa`: your address) |
| `signer` | same as `maker` in `eoa` mode |
| `taker` | must be the zero address (open order). Directed fills are rejected |
| `tokenId` | YES or NO position id from the market |
| `makerAmount` / `takerAmount` | raw 6-decimal units; BUY gives USDC, receives contracts. `takerAmount` is `1` for FOK |
| `expiration` | **must be `0`**; non-zero is rejected |
| `nonce` | **must be `0`**; non-zero is rejected |
| `feeRateBps` | on fee-bearing markets (`metadata.fee`) must equal your profile's `rank.feeRateBps` from `GET /profiles/me` or the order fails `feeRateBps[...] is out of user's band`; sign `0` only on markets without the flag |
| `side` | `0` = BUY, `1` = SELL |
| `signatureType` | `0` = EOA |

### Amounts from price + USD

```typescript
const price = 0.50, usd = 2.00;
const rawContracts = BigInt(Math.floor((usd * 1_000_000) / price)); // 4_000_000n
const takerAmount = (rawContracts / 1000n) * 1000n;                  // grid-aligned
const makerAmount = (takerAmount * BigInt(Math.floor(price * 1_000_000))) / 1_000_000n; // 2_000_000n = $2
```

---

## 15. Contract Addresses

All on **Base** (chain id 8453). Explorer: [basescan.org](https://basescan.org).

| Contract | Address | Purpose |
|----------|---------|---------|
| **USDC** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Collateral (ERC-20, 6 decimals) |
| **CTF** | `0xC9c98965297Bc527861c898329Ee280632B76e18` | Conditional Tokens Framework (ERC-1155): balances, standard redemption |
| **Exchange** | `market.venue.exchange` | Order settlement; the EIP-712 `verifyingContract`. Differs between standard and neg-risk markets |
| **NegRisk adapter** | `market.venue.adapter` | Grouped markets: approvals for SELL and redemption of neg-risk positions |

Never hardcode exchange or adapter addresses; read them from the market. The full contract list is at [Smart contracts](https://docs.limitless.exchange/user-guide/smart-contracts).

---

## 16. Fees and Taker Delay

### Fees

- **Maker fills pay nothing.** Orders that rest on the book and get filled pay no fee.
- **Takers pay** a fee computed per fill on the size-weighted average price, charged in the asset received: BUY fees in shares (`feeAmountContracts`), SELL fees in USDC (`feeAmountCollateral`).
- The published BUY rate is 3.00% for outcomes priced $0.01–$0.50, tapering above; SELL peaks at 1.50% around $0.50. The complete curve: [Fees](https://docs.limitless.exchange/user-guide/fees). `execution.effectiveFeeBps` on the order result is the rate actually applied.
- `market.metadata.fee` marks a fee-bearing market; your signed `feeRateBps` must equal `rank.feeRateBps` there (section 14).
- Cheap-leg baskets start ~3% behind. Any "arbitrage" that needs several taker legs must net the fee first; `mcp-skills/limitless-group-scan` shows the arithmetic.

### Taker delay

Some markets hold marketable (taker) orders briefly before matching (`settings.takerDelayMs`, milliseconds, `0` = none; capped at a few seconds). What it changes:

- FOK and FAK on such a market return immediately with `execution.settlementStatus: "DELAYED"`, `matched: false`, and `eligibleAt`. The fill arrives later: over `subscribe_order_events` (SETTLEMENT `MATCHED` → `MINED`/`FAILED`) or via `POST /orders/status/batch` after `eligibleAt`.
- GTC orders, post-only quotes, and cancels are never delayed.
- A delayed FOK that ends up killed emits **no** websocket frame; poll `status/batch` after `eligibleAt` to learn it (`SDKTradingClient.awaitFill` does).
- Maintenance mode can postpone a delayed fill past `eligibleAt`; keep the order open in your bookkeeping until a terminal state.
- Self-trade prevention (`stpPolicy`, default `cancel_maker`) is applied at release time.

Read the field per market. Sports markets currently carry a delay; others may too. `BaseStrategy` with `awaitFills = true` waits out the delay automatically.

---

## 17. Building Your Own Strategy

### Step 1: Copy the template

```bash
cp -r src/strategies/template src/strategies/my-strategy
```

### Step 2: Implement the four methods

```typescript
// src/strategies/my-strategy/index.ts
import { BaseStrategy, type StrategyConfig, type StrategyDeps, type StrategyStats, type TradeDecision } from '../base-strategy.js';
import { toFraction } from '../../core/limitless/types.js';

export class MyStrategy extends BaseStrategy {
  constructor(config: StrategyConfig, deps: StrategyDeps) {
    super(config, deps);
    this.tickIntervalMs = 30_000;
    this.awaitFills = true;   // block on taker orders until MINED / killed (honors taker delay)
  }

  async initialize(): Promise<void> { /* connect feeds, load state */ }

  async tick(): Promise<TradeDecision[]> {
    const markets = await this.limitless.getActiveMarkets({ tradeType: 'clob', limit: 25 });
    const decisions: TradeDecision[] = [];
    for (const m of markets) {
      const yes = toFraction(m.prices?.[0]);
      const fair = this.fairValue(m);           // YOUR SIGNAL
      if (fair - yes > 0.10) {
        decisions.push({
          action: 'BUY', marketSlug: m.slug, side: 'YES',
          amountUsd: 1, priceLimit: Math.round(yes * 100) + 2, orderType: 'FOK',
          reason: `fair ${fair.toFixed(2)} vs ${yes.toFixed(2)}`,
        });
      }
    }
    return decisions;                             // BaseStrategy executes them
  }

  async shutdown(): Promise<void> { /* cancel quotes, close feeds */ }
  getStats(): StrategyStats { return { activePositions: 0, totalVolumeUsd: 0, pnlUsd: 0, lastTickDurationMs: this.lastTickDurationMs }; }
  private fairValue(market: { prices?: number[] }): number { return toFraction(market.prices?.[0]); }
}
```

`TradeDecision` fields: `action` (`BUY` | `SELL` | `SKIP`), `marketSlug`, `side`, `amountUsd` (BUY notional), `shares` (SELL), `priceLimit` (cents), `orderType` (default BUY → FOK, SELL → FAK), `postOnly` (GTC), `reason`.

### Step 3: Runner + npm script

Copy `src/strategies/template/run.ts` (it builds one shared SDK client, `LimitlessClient`, and `SDKTradingClient` from env, wires SIGINT/SIGTERM to `stop()`), then add `"my-strategy": "tsx src/strategies/my-strategy/run.ts"` to `package.json`.

### The tick() loop

```
initialize() → tick() → execute decisions → wait → tick() → …
```

- A thrown `tick()` is logged and the loop continues.
- Interval self-adjusts: `next = max(1s, tickIntervalMs − tickDuration)`.
- `stop()` breaks the loop and runs `shutdown()`.

### Where an edge comes from

1. **External price** vs the market's strike (`oracle-arb`)
2. **Cross-venue** comparison (`cross-market-mm`)
3. **Statistical** models of the underlying
4. **Orderbook** structure (depth imbalance, stale quotes)
5. **Time decay** near resolution (`certainty-closer`, honestly framed: no edge on its own)

### Sizing

Fixed size is fine to start. `kellySize()` (`src/core/kelly.ts`) sizes to your asserted edge with a hard cap; quarter-Kelly by default.

### Making vs taking

Resting post-only GTC quotes pay no fee and can earn LP rewards inside the market's `maxSpread` band (`settings.dailyReward`, `rewards.isEarning` on your positions). Taking pays the fee curve. A quoting loop should use `cancelReplace` and keep a minimum re-quote interval; `cross-market-mm` shows a full implementation (queue-position-aware requoting, hedging, breakers).

### Recording runs

Append one JSON line per event (config, order, result, exposure snapshot) to `./data/<strategy>-<ts>.jsonl` and write an `analyze.ts`. `cross-market-mm/recorder.ts` + `analyze.ts` is the reference.

### Adding a price feed

Put it in `src/core/price-feeds/`; `hermes.ts` (Pyth over SSE, EventEmitter, auto-reconnect) is the pattern.

---

## 18. Autonomous Iteration

```
1. DRY-RUN   npm run <strategy>         confirm it boots, scans, and would trade sanely
2. GO LIVE   DRY_RUN=false, small size  watch the first minutes
3. ANALYZE   the run's JSONL / status   fills, fees, PnL, how flat you stayed
4. ADJUST    .env / strategy config     thresholds, sizing, market selection
5. REPEAT
```

### Metrics to track

| Metric | Tells you | Action |
|--------|-----------|--------|
| Fill rate by order type | whether your prices are competitive | move quotes, or take instead of make |
| Win rate by market / asset | where the signal works | drop losers |
| Avg PnL per trade net of fees | real edge | must be positive |
| Max drawdown | worst streak | reduce size or add a breaker |
| Taker fee paid | cost of urgency | more post-only |

### Scale up / pull back

Scale when the win rate holds over 30+ trades and PnL is positive across days. Pull back on 5 consecutive losses, a win rate below 50% over 10+ trades, or illiquid conditions. Halt on anything unexplained.

### Running unattended

Use a process manager (pm2/systemd; `ops/cross-market-mm.service` and `Procfile` are examples). Add a heartbeat that reads the strategy's status or `npx tsx src/scripts/check-balances.ts`, and cron `npm run redeem claim-all` daily.

---

## 19. Safety, Risk & Market Integrity

### Rule #1: DRY_RUN first, always

Every new strategy, parameter change, or code change runs with `DRY_RUN=true` first. Read the decisions. Then, and only then, `DRY_RUN=false` with small size.

### Rule #2: dedicated wallet, small balance

Blast-radius containment, budget enforcement, clean accounting. Fund only what you can lose.

### Rule #3: never cancel CLOB orders on-chain

Cancel through the API (`cancelOrder`, `cancelAll`, `cancelReplace`). Any on-chain `OrderCancelled` from your maker address gets it added to the trader blocklist. Other automatic blocks: rejecting ERC-1155 transfers, invalid on-chain nonces.

### Rule #4: know the integrity rules

Limitless enforces **self-trade prevention** (`stpPolicy`: `cancel_maker` default, `cancel_taker`, `cancel_both`; same profile + same token only) and a **zero-address taker** rule (no directed fills). There are no per-account exposure caps; rate limits are enforced at the edge. Read [Responsible agents](https://docs.limitless.exchange/developers/responsible-agents) before letting an agent trade, and report abuse to help@limitless.network.

### Rule #5: sizing and stops

- Start at $1–$2 per order until you have a track record
- Cap total exposure and single-trade size in your strategy config
- Stop on 5 consecutive losses, a drawdown past your limit, or an API/liquidity regime change
- Prediction markets carry variance even with an edge. Never risk what you cannot lose.

---

## 20. Common Patterns & Recipes

### Scan CLOB markets and rank by spread

```typescript
const markets = new LimitlessClient();
const list = await markets.getActiveMarkets({ tradeType: 'clob', limit: 25, sortBy: 'ending_soon' });
const rows = await Promise.all(list.map(async (m) => {
  const book = await markets.getOrderbook(m.slug);
  const bid = book.bids[0]?.price ?? null, ask = book.asks[0]?.price ?? null;
  return { slug: m.slug, title: m.title, bid, ask, spread: bid !== null && ask !== null ? ask - bid : null, twoSided: bid !== null && ask !== null };
}));
rows.filter((r) => r.twoSided).sort((a, b) => a.spread! - b.spread!);
```

### Rest a post-only quote, then re-quote atomically

```typescript
const res = await trading.createOrder({ marketSlug, side: 'YES', limitPriceCents: 45, usdAmount: 5, orderType: 'GTC', postOnly: true });
// later, the fair value moved:
await trading.cancelReplace({ orderId: res.order.id, marketSlug, side: 'YES', limitPriceCents: 44, shares: 11.111, postOnly: true });
```

### Take liquidity and confirm the fill

```typescript
const res = await trading.createOrder({ marketSlug, side: 'NO', limitPriceCents: 62, usdAmount: 3, orderType: 'FOK' });
const fill = await trading.awaitFill(res.order.id, 'FOK', { eligibleAt: res.execution?.eligibleAt });
if (fill.state === 'filled') console.log(`bought ${fill.contracts} NO @ ${fill.avgPrice} (fee ${fill.effectiveFeeBps} bps)`);
```

### Watch books and your own orders live

```typescript
const stream = new LimitlessStream();
await stream.connect();
await stream.subscribeMarkets(['slug-a', 'slug-b']);
await stream.subscribeOrderEvents();
stream.onOrderbook((u) => { /* snapshot first, then updates */ });
stream.onOrderEvent((e) => { if (isTerminalOrderEvent(e)) { /* reconcile */ } });
```

### Check positions, P&L, and history

```typescript
const portfolio = new PortfolioClient();
const { clob, rewards } = await portfolio.getPositions();
for (const p of clob) console.log(p.market.slug, p.tokensBalance, p.positions.yes.unrealizedPnl, p.rewards?.isEarning);
const { data, nextCursor } = await portfolio.getHistory();
```

### Redeem winnings

```bash
npm run redeem claim-all
```

```typescript
const result = await new RedeemClient().claimAll(await new RedeemClient().portfolioSlugs());
```

### Approve, doctor, wallet mode

```bash
npm start approve <slug>
npm run doctor -- --market <slug>
npm start wallet-mode eoa
```

---

## 21. Agent Integration Patterns

### Pattern 1: setup from scratch

```
git clone … && cd agents-starter && npm install && npm run init
→ operator fills .env (never through the agent)
npm run doctor            # must be READY
timeout 30 npm run certainty-closer   # dry run boots, scans, logs would-be orders
```

### Pattern 2: heartbeat

Every N minutes: is the process alive (pm2/systemd)? Read the strategy's status file or `check-balances`. If equity is below the floor or a position is unhedged: cancel-all, flatten, page the operator. Daily: `npm run redeem claim-all`.

### Pattern 3: parameter iteration

Read the run's JSONL, bucket by edge / market / time-to-expiry, move the threshold, restart in `DRY_RUN`, confirm, then live.

### Pattern 4: emergency shutdown

```
stop the process → npm run cross-market-mm:close (or cancelAllAndVerify per market)
→ npm run redeem claim-all → report final balances
```

### Pattern 5: several strategies

One `.env` per instance (`DATA_DIR`, sizes, thresholds), one process each, separate wallets if the strategies could cross each other (self-trade prevention cancels your own resting quotes).

---

## 22. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Signer does not match - you should use embedded address for smart wallet` | profile is in `smartWallet` trading mode | `npm start wallet-mode eoa` (`doctor` catches it) |
| `Signer does not match authenticated profile account` / `Maker does not match expected profile wallet` | the token was derived by a different wallet than `PRIVATE_KEY` | derive the token while connected with the signing wallet |
| `401 Invalid HMAC authentication` | wrong secret, or the machine clock is off (short timestamp window) | re-copy the base64 secret; sync the clock |
| `Insufficient collateral allowance` | exchange not approved | `npm start approve <slug>` |
| `Insufficient conditional token balance` | selling more shares than held (rounding up) | floor to the 0.001 grid; `sellShares` does |
| `feeRateBps[...] is out of user's band` | signed `feeRateBps` ≠ `rank.feeRateBps` on a fee-bearing market | let the SDK set it; check `GET /profiles/me` |
| `Post-only order would execute immediately` / `Order would cross resting liquidity` | normal flow | reprice; do not blacklist the market |
| `settlementStatus: DELAYED` | taker delay, not an error | wait for `eligibleAt`, watch order events or `awaitFill` |
| FOK into an empty book errors | no resting liquidity | check `bids.length && asks.length` first |
| Orderbook prices look 100× off | listings use cents, books use fractions | `toFraction()` |
| `Market … has passed deadline` | market closed between scan and order | skip |
| `429` | edge rate limit | slow the loop; cancel-replace instead of cancel+create |
| Websocket: one snapshot then silence | a later `subscribe_market_prices` replaced the set, or the slug resolved | send the full set every time; check `market.status` |
| Websocket `unsubscribe` times out | no generic unsubscribe exists | re-subscribe with the smaller set |
| Redeem fails right after resolution | payout not yet reported on-chain | retry in a few minutes |
| Neg-risk claim `No position balance` via the API | grouped markets redeem through the adapter | `RedeemClient` handles it; or `POST /portfolio/redeem` for server wallets |
| `DRY_RUN` not respected | env and config disagree | pass `dryRun` explicitly; both `SDKTradingClient` and strategies read one resolved flag |
| `PRIVATE_KEY` format error | not 0x + 64 hex | `doctor` |

---

## 23. Links and Resources

### Limitless
- App: [limitless.exchange](https://limitless.exchange)
- Developer docs: [docs.limitless.exchange/developers/introduction](https://docs.limitless.exchange/developers/introduction) · [API reference](https://docs.limitless.exchange/api-reference/introduction) · Scalar: `https://api.limitless.exchange/api-v1`
- [Authentication](https://docs.limitless.exchange/developers/authentication) · [EIP-712](https://docs.limitless.exchange/developers/eip712-signing) · [WebSocket](https://docs.limitless.exchange/developers/websocket/overview) · [Fees](https://docs.limitless.exchange/user-guide/fees) · [Responsible agents](https://docs.limitless.exchange/developers/responsible-agents) · [Maintenance mode](https://docs.limitless.exchange/developers/maintenance-mode) · [Migrate from Polymarket](https://docs.limitless.exchange/developers/migrate-from-polymarket)
- [Build a trading agent](https://docs.limitless.exchange/developers/build-a-trading-agent) (this repo's companion guide) · [Cross-market market making](https://docs.limitless.exchange/developers/cross-market-market-making)
- Docs MCP: `https://docs.limitless.exchange/mcp` · Trading MCP: `https://api.limitless.exchange/mcp` ([guide](https://docs.limitless.exchange/developers/mcp-server))
- [Programmatic API](https://docs.limitless.exchange/developers/programmatic-api) (partners only)
- [Builders Chat](https://t.me/LimitlessBuildersChat) · [Changelog](https://docs.limitless.exchange/changelog)

### Official SDKs
- TypeScript: [npm](https://www.npmjs.com/package/@limitless-exchange/sdk) · [GitHub](https://github.com/limitless-labs-group/limitless-exchange-ts-sdk)
- Python: [PyPI](https://pypi.org/project/limitless-sdk/) · [GitHub](https://github.com/limitless-labs-group/limitless-sdk)
- Go: [GitHub](https://github.com/limitless-labs-group/limitless-exchange-go-sdk)
- Rust: [GitHub](https://github.com/limitless-labs-group/limitless-exchange-rust-sdk)

### Related tools
- [limitless-cli](https://github.com/limitless-labs-group/limitless-cli): Rust CLI for markets, orderbooks, orders, approvals
- [limitless-feeds-cli](https://github.com/limitless-labs-group/limitless-feeds-cli): map price markets to Pyth / Chainlink / Binance feeds
- [Limitless Academy](https://academy.limitless.exchange): the API and Agents academies; this repo is their reference agent

### Infrastructure
- [basescan.org](https://basescan.org) · [bridge.base.org](https://bridge.base.org) · USDC on Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Pyth Hermes: [hermes.pyth.network](https://hermes.pyth.network)

---

*Built for any coding agent with shell + file access. Query the docs MCP. Dry-run first. Track everything. Scale winners.*
