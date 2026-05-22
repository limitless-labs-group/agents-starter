# Replicator strategy

Cross-venue market-making: mirror Polymarket orderbook liquidity onto Limitless,
hedge fills back on Polymarket. Net delta stays ~flat; you earn the spread
between the two venues plus any Limitless maker rebates.

> [!WARNING]
> **Moves real money on two chains** (Base + Polygon). Vibe-coded reference
> implementation, not production trading infrastructure. **Use a dedicated
> wallet** and always start with `DRY_RUN=true`.

## How it works

```
                      ┌────────────────────┐
   Polymarket WS ───▶ │  core/polymarket/  │  best bid/ask per slug → QuoteFeed
                      │  ws.ts             │  (everything in YES-frame)
                      └─────────┬──────────┘
                                │ updates wake the replicator
                                ▼
              ┌─────────────────────────────────────────────┐
              │  strategies/replicator/index.ts (per pair)  │
              │   • cancel all open Limitless orders        │
              │   • place YES BUY @ (poly_bid - margin)     │
              │   • place NO  BUY @ (1 - poly_ask) - margin │
              └─────────────────────────────────────────────┘
                                │ fills accumulate
                                ▼
              ┌─────────────────────────────────────────────┐
              │  strategies/replicator/hedger.ts            │
              │   • poll positions on both venues every 5s  │
              │   • if |net exposure| > threshold:          │
              │       fire FAK BUY on Polymarket to flatten │
              └─────────────────────────────────────────────┘
```

## Setup

```bash
# from agents-starter root
npm install

# .env already covers PRIVATE_KEY + LIMITLESS_API_KEY (shared with other strategies)
# Add DRY_RUN=true to start safely (default in config.example.yaml too).

cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
# Edit ./replicator.config.yaml:
#   - poly_funder        — Polymarket UI address
#   - poly_signature_type — 2 (legacy Safe) or 3 (new deposit wallet)
#   - market_pairs       — same event listed on both venues

npm run replicator
```

Stop with Ctrl-C. On shutdown, the bot cancels every open Limitless order so
nothing rests on the book.

## Polymarket wallet types

The single most common configuration mistake. The user-facing
`poly_signature_type` matches what Polymarket's UI tells you:

| Account vintage | `poly_funder` is the | Set `poly_signature_type` to |
|---|---|---|
| Created **before** CLOB V2 (legacy) | proxy / Gnosis Safe address | `2` |
| Created **after** CLOB V2 (current) | deposit wallet address | `3` |

If the boot-time auth probe says **"Polymarket auth probe failed"**, you have
the wrong sig type. Flip the bit and re-run.

## Strategy invariants

These are load-bearing. Re-derive the math before changing any of them:

1. **Both Limitless quotes are BUY.** YES BUY at `poly_bid - margin`. NO BUY at
   `(1 - poly_ask) - margin`. We never SELL on Limitless. The asymmetry is
   intentional — Polymarket's sell semantics + Limitless's fee tier interact
   in ways the BUY-only path side-steps.
2. **Cancel-all + replace every tick.** No diff optimizer. The Poly book
   updates a few times per second; cancel+replace cost is cheaper than
   divergence risk from clever updates.
3. **Hedge always BUYs on Polymarket.** Too much YES → BUY NO. Too much
   NO → BUY YES. Never sell on Poly.
4. **YES-frame is canonical** everywhere downstream of the WS listener.
   A NO-asset update is inverted (`YES_ask = 1 - NO_bid`) before it
   reaches the QuoteFeed. Consumers can assume `quote.bid` and `quote.ask`
   refer to the YES outcome.

## DRY_RUN mode

`DRY_RUN=true` in your env (or `dry_run: true` in YAML) does:

- Skips the Polymarket CLOB auth derivation (no `deriveApiKey` call).
- Cancel / place / hedge all short-circuit to a `[DRY_RUN] would …` log line.
- All reads (markets, positions, WS book) still happen — config is end-to-end
  validated.

This is the right way to start. Watch the log for a few minutes, sanity-check
the quote prices and hedge directions, then flip the bit.

## Will this make money?

Be honest: **the bot is infrastructure, the strategy is your job.** Default
config (margin 100bps, Bronze fee tier 300bps on Limitless, FAK taker fee
~50–200bps on Polymarket) is a slight net loss per round-trip. Real PnL
requires one of:

1. **Limitless maker rebate program** — documented at
   [docs.limitless.exchange/user-guide/maker-rebates](https://docs.limitless.exchange/user-guide/maker-rebates).
   Your maker fills generate rebate credit, paid daily in USDC. Eligibility
   varies by market.
2. **Higher Limitless fee tier** — Silver (260bps) → Gold (215bps) → Diamond
   (120bps), gated on platform points. Volume gets you there over time.
3. **Edge in pair selection** — markets where the cross-venue spread is wider
   than fees, or where the Limitless book is thin relative to Polymarket.
4. **Wider `margin_bps`** — fewer fills but each one is profitable. Tune
   per pair.

## Tests

```bash
npm test
```

Unit tests cover:

- `replicator-math` — `clipPrice`, `computeBuyPrices` (BUY-only invariants,
  margin behavior, clipping at edges)
- `hedger-math` — `decideHedge` direction, notional math, dust gate,
  cross-venue netting, missing-quote handling
- `poly-ws-inversion` — `applyBook` + `applyPriceChange` YES pass-through,
  NO→YES inversion, best-price aggregation, `QuoteFeed` waiter semantics

## Differences from `limitless-replicator` (Python original)

This is a TS port of [limitless-labs-group/limitless-replicator](https://github.com/limitless-labs-group/limitless-replicator).
Material differences:

- **Limitless side uses `@limitless-exchange/sdk`** instead of hand-rolled
  EIP-712. Venue/exchange routing (default CTF vs neg-risk) is automatic.
- **Polymarket side uses `@polymarket/clob-client`** instead of `py-clob-client-v2`.
- **User-facing `poly_signature_type` semantics preserved** (2 = legacy Safe,
  3 = new deposit wallet). Translated to the TS client's enum internally.
- **Same strategy** — identical quote math, identical hedge logic, identical
  cancel-on-shutdown behavior.

The original Python repo is the longer-form "everything visible" reference
implementation. This TS version is what agents-starter ships and is what
OpenClaw skill consumers run.
