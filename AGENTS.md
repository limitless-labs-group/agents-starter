# Operating guide for AI agents

You are operating a real-money trading-agent repo on Limitless Exchange (Base).
**This file is your contract.** For depth, read `SKILL.md` (the full manual:
market structure, SDK reference, websocket semantics, fees, footguns) and the
strategy's own `SKILL.md` under `src/strategies/<name>/`.

## Install (one line)

```sh
curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh
```

Checks prerequisites (Node 20+), clones, installs, scaffolds `.env`. Then the
operator adds credentials and you verify them:

```sh
npm run doctor            # key · token · trading-wallet mode · USDC/ETH balances
```

## Safety contract (non-negotiable)

- **The operator's `PRIVATE_KEY` and token secret stay out of your context.**
  Never ask them to paste either, never echo them, never `cat .env`, never read
  a secret back. They place them in `.env` themselves; `init` and `doctor` are
  built to never print them.
- **Dedicated wallet only.** Confirm with the operator it is not their main wallet.
- **Start in `DRY_RUN=true`.** Go live only after a clean dry run *and* the
  operator's explicit go-ahead. `doctor` must be green first.
- **Confirm before any action that spends gas, moves funds, or goes live.**
- **Never cancel CLOB orders on-chain.** Cancel through the API. An on-chain
  `OrderCancelled` gets the maker address blocked. See
  https://docs.limitless.exchange/developers/responsible-agents
- If anything looks wrong (unexpected loss, an unhedged position, a stuck or
  orphaned order) **halt, cancel, flatten, and report.** Do not keep bleeding.

## The flow

```
install → init → operator fills .env → doctor → dry run → approve <slug>
        → live (on go-ahead, small size) → monitor → cancel-all / close → redeem
```

## Commands

| Command | Purpose |
|---|---|
| `npm run init` | Scaffold `.env` + `data/`, list credentials to add (never reads secrets) |
| `npm run doctor [-- --market <slug>] [-- --json]` | Preflight; non-zero exit if orders would be rejected |
| `npm start approve <slug>` | Approve USDC + CTF for the market's exchange (+ neg-risk adapter). One-time per exchange. Costs gas. |
| `npm start wallet-mode eoa` | Fix the `smartWallet` trap (self-signed orders rejected) |
| `npm start whoami` | Authenticated profile: id, account, wallet mode, fee tier |
| `npm run template` | Bare strategy skeleton to build on |
| `npm run certainty-closer` / `oracle-arb` / `cross-market-mm` | Shipped strategies, all `DRY_RUN` by default |
| `npm run example:place-order` / `example:stream` | Runnable SDK examples (order lifecycle, websocket) |
| `npm run redeem claim-all` | Claim winnings from resolved markets (standard + neg-risk). Costs gas. |
| `npx tsx src/scripts/check-balances.ts` | On-chain + Limitless balances, open positions, claimable winnings |
| `npm run typecheck && npm test` | Quality gate; run after any code change |

## Reading an order result

Branch on `execution.settlementStatus`, never on `matched`
(`src/core/limitless/execution.ts` does this for you):

| settlementStatus | Meaning | Action |
|---|---|---|
| `MINED` / `CONFIRMED` | settled on-chain | done |
| `UNMATCHED` | FOK/FAK: nothing filled. GTC: resting on the book | FOK/FAK: no position. GTC: wait or cancel |
| `DELAYED` | held by the market's taker delay until `eligibleAt` | not an error; watch order events or `awaitFill` |
| `MATCHED` / `RETRYING` | provisional | keep watching |
| `FAILED` / `CANCELED` | terminal failure (CANCELED = self-trade prevention) | log, do not retry blindly |

Rejected orders are an HTTP status plus a `message` string; there is no
machine-readable error code. Do not blacklist a market on normal-flow
rejections ("would cross resting liquidity", "post-only would execute").

## Monitoring

- Every strategy logs each decision and its order result (pino JSON).
- `cross-market-mm` also maintains `data/cross-market-mm-status.json` and the
  Academy operator-panel data contract (`data/quotes.json`, `positions.json`,
  `fills.ndjson`, `kill.flag`, `pull.flag`). Details in
  `src/strategies/cross-market-mm/SKILL.md`.
- For any strategy, `npx tsx src/scripts/check-balances.ts` is an independent
  read of the venue state.

## cross-market-mm specifics

The cross-venue strategy adds a Polymarket leg. Its guided setup is
`npm run cross-market-mm:init` (loop until funded), then
`find-pairs → preflight → run → status → close`. When picking a pair,
`find-pairs` flags polarity-flipped candidates; still confirm both markets
resolve on identical criteria (same asset, threshold, UTC moment, source).
Title similarity is not enough. Full manual: `src/strategies/cross-market-mm/SKILL.md`.

## Conventions when changing code

- Everything Limitless goes through the official SDK via
  `src/core/limitless/client.ts`; never hand-roll HTTP, HMAC, or EIP-712.
- `DRY_RUN` gates must short-circuit **before** any network call.
- `npm run typecheck && npm test` must pass; tests never touch the network.
- Verify wire shapes against the live docs before adding an API call:
  docs MCP at `https://docs.limitless.exchange/mcp`, API reference at
  https://docs.limitless.exchange/api-reference/introduction
