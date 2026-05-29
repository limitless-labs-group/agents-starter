# Oracle arb — feed-driven edge detection on Limitless

Canonical operating manual. Any agent with shell + file access and this file can
take oracle-arb from clone → dry-run → live. For the fast path, see
**[QUICKSTART.md](./QUICKSTART.md)**.

The idea: a fast oracle (Pyth, via Hermes SSE) tells you where a crypto price sits
relative to a short-dated Limitless market's strike. When the market hasn't
repriced to match, that gap is the edge. The bot quantifies it and fires
fill-or-kill orders when the gap clears a threshold. Single venue (Limitless),
single chain (Base), SDK-only — there is no hedge leg.

> [!WARNING]
> **Moves real money on Base.** Reference implementation, not production trading
> infrastructure. Use a dedicated wallet, start in `DRY_RUN`, and keep
> `ORACLE_BET_SIZE` small until you trust the signal.

## 1. How it works

Each tick (10s normally, 3s in the "golden window" — the last/first ~3 minutes of
each UTC hour, when hourly markets are about to resolve):

1. **Read the oracle.** Pull each asset's latest price + confidence from the
   Hermes stream (`https://hermes.pyth.network/v2/updates/price/stream`). Skip an
   asset if its confidence band is too wide (`minConfidencePercent`).
2. **Find markets.** Search Limitless for CLOB markets matching the asset, within
   the `[minMinutesToExpiry, maxMinutesToExpiry]` window. AMM markets are skipped.
3. **Parse the strike** from `metadata.openPrice` or the market title (e.g.
   "above $0.097…").
4. **Estimate probability.** Convert how far the oracle price sits from the strike
   into an implied YES probability (a bounded linear heuristic, clamped to
   0.05–0.95).
5. **Compute edge** = oracle probability − market price, per side. If it clears
   `minEdgePercent`, the price is inside `[minMarketPrice, maxMarketPrice]`, and
   the oracle is confident, re-check the **actual orderbook ask** and recompute
   edge against the real fill price (an empty book is skipped — a FOK into no
   liquidity errors out).
6. **Fire FOK** at 1¢ above the ask (capped at 95¢). High-conviction signals
   (≥90%) split the bet across a small price ladder instead.

Positions persist to `data/oracle-arb-positions.json` so restarts don't re-enter
a market; entries older than 2h are pruned from the count.

## 2. Auth + funding

- **Limitless:** `PRIVATE_KEY` (signs orders) + a scoped HMAC token
  (`LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`). A legacy `LIMITLESS_API_KEY` still
  works if you hold one. See [Authentication](https://docs.limitless.exchange/developers/authentication).
- **Base:** USDC (collateral) + a little ETH (gas) on your EOA. The bot reads your
  on-chain USDC balance each minute and **refuses to trade at `$0`**.
- No Polymarket, no second chain.

## 3. Configuration

All env-driven with defaults (set in `run.ts`):

| Env var | Default | What it gates |
|---|---|---|
| `ORACLE_ASSETS` | `BTC,ETH,SOL` | Pyth tickers to watch ([feed IDs](https://pyth.network/developers/price-feed-ids)) |
| `ORACLE_MIN_CONFIDENCE` | `0.82` | Min oracle confidence + min implied prob to trade a side |
| `ORACLE_MIN_EDGE` | `0.20` | Min oracle-vs-market gap (0..1) before a trade |
| `ORACLE_MIN_PRICE` | `0.30` | Price floor — skip if the book prices your side below this |
| `ORACLE_MAX_PRICE` | `0.65` | Price ceiling — skip if your side costs more than this |
| `ORACLE_BET_SIZE` | `1` | USD per trade |
| `ORACLE_MAX_POSITIONS` | `10` | Max concurrent positions before opening new ones stops |
| `ORACLE_MIN_MINUTES` | `0` | Min time-to-expiry to consider a market |
| `ORACLE_MAX_MINUTES` | `90` | Max time-to-expiry to consider a market |
| `DRY_RUN` | `true` | `false` to place real orders |

## 4. Commands

```bash
npm run oracle-arb            # run (DRY_RUN by default); Ctrl-C to stop
npm run redeem claim-all      # redeem winnings after markets resolve
```

Live runs **auto-approve** a market's exchange (USDC + CTF) the first time they
trade there, so there's no separate approve step.

## 5. Economics + edge

FOK orders are always **taker** orders, so you pay the Limitless
[taker fee](https://docs.limitless.exchange/user-guide/fees) on every fill — there
are no maker rebates here. Profit has to come from the oracle being right about
direction more often than the fee + the times the market was right and you weren't.

Be clear-eyed about the signal: the oracle-to-probability step is a heuristic, not
a calibrated model, and the `ORACLE_MIN_PRICE` floor encodes the fact that a market
pricing your side very cheap usually has information a point-in-time oracle lacks.
This is a teaching scaffold for feed-driven trading — to make it genuinely
profitable you would replace the linear probability heuristic with a calibrated
model and tighten the entry filters.

## 6. Risk + invariants

- **Directional, unhedged.** Every position is a one-sided bet; a wrong call loses
  the full stake. Keep `ORACLE_BET_SIZE` and `ORACLE_MAX_POSITIONS` modest.
- **Balance gate.** Trading halts at `$0` USDC; it does not borrow or oversize.
- **No re-entry.** A market is traded at most once per run (tracked in the
  positions file).
- **Empty-book guard.** FOK is only sent when the book has real liquidity on your
  side.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Portfolio balance is $0` | Deposit USDC to your EOA on Base. |
| `Hermes SSE` reconnect loops | Transient feed/network blip; the client auto-reconnects. Check the asset tickers are valid Pyth feeds. |
| Never trades | Edges are rare. Loosen `ORACLE_MIN_EDGE`, widen `ORACLE_MAX_MINUTES`, or confirm there are live crypto markets in the window. |
| `not approved` on first live trade | The auto-approve retry handles this; if it fails, run `npm start approve <slug>` for that market's exchange. |
