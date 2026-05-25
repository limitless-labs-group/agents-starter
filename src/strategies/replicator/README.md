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

## Quick start

```bash
# 1. From the repo root:
npm install
cp .env.example .env
chmod 600 .env
# Edit .env — set PRIVATE_KEY + a Limitless scoped HMAC token.
# Get the token from the UI: limitless.exchange → connect wallet →
# API token modal → "API Tokens" tab → Derive → copy tokenId + secret
# into LMTS_TOKEN_ID + LMTS_TOKEN_SECRET. DRY_RUN is already true.

# 2. Pick a market pair. Both venues need an *equivalent* market — same
#    asset, same threshold, same UTC moment, same data source.
npm run replicator:find-pairs
# Scans Limitless's active CLOB markets + Polymarket's active binary
# markets, ranks candidates by title-token Jaccard, prints paste-ready YAML.

# 3. Configure the bot.
cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
# Edit ./replicator.config.yaml:
#   - poly_funder        — the address Polymarket's UI shows you
#   - poly_signature_type — 2 (legacy Safe) or 3 (new deposit wallet)
#   - market_pairs       — paste from find-pairs output
#   - order_size         — see "Capital math" below before raising this

# 4. Smoke it in DRY_RUN first.
npm run replicator
# Watch the log for a few minutes. Confirm:
#   • Limitless + Polymarket markets resolved
#   • Poly WS connected
#   • Cancel-replace cycle firing on every Poly tick
# Ctrl-C to stop. On shutdown the bot cancels all open Limitless orders.
```

## What a healthy DRY_RUN boot looks like

```
WARN: ═══════════════ DRY_RUN MODE ═══════════════
  No orders signed or sent. Place/cancel/hedge → log-only.
  Polymarket auth probe is SKIPPED in dry-run.
INFO: SDKTradingClient initialized          { address: 0x… }
WARN: PolymarketAdapter: DRY_RUN — CLOB client not initialized
INFO: replicator boot                       { pairs: 1, orderSize: 100, marginBps: 100, dryRun: true }
INFO: Limitless trader                      { address: 0x… }
INFO: [DRY_RUN] skipping Polymarket auth probe
INFO: Limitless market resolved             { slug: '<lmts-slug>', yes: '83954139…', exchange: '0x05c7…' }
INFO: Polymarket assets resolved            { slug: '<poly-slug>', yes: '94559586…', no: '90772332…' }
INFO: hedger started                        { intervalSec: 5 }
INFO: replicator started                    { polymarketSlug: '…', limitlessSlug: '…' }
INFO: bot running. Ctrl-C to stop.
INFO: Poly WS connected                     { count: 2 }
# Then, every Poly book tick:
INFO: [DRY_RUN] would cancelAll             { marketSlug: '…' }
INFO: [DRY_RUN] would createOrder via SDK   { side: 'NO',  price: 0.92, usdAmount: 92.2, orderType: 'GTC' }
INFO: [DRY_RUN] would createOrder via SDK   { side: 'YES', price: 0.06, usdAmount: 5.7,  orderType: 'GTC' }
```

If the cancel-replace cycle isn't firing within ~5 seconds of `Poly WS connected`,
the Polymarket book isn't quoting (or your slug is wrong). Check Troubleshooting.

## Capital math — sizing before going live

Each pair keeps **two limit orders** resting on Limitless. Combined locked
capital per pair ≈ `order_size × 1` USDC (the YES BUY + NO BUY prices sum to ~$1).

```
   per-pair locked ≈ order_size × (poly_bid + (1 - poly_ask) - 2 × margin)
                   ≈ order_size × 1  ($1 per share total across both quotes)
```

So:

| `order_size` | Limitless capital locked per pair |
|---|---|
| 10  | ~$10 |
| 50  | ~$50 |
| 100 | ~$100 (default) |
| 250 | ~$250 |

**Asymmetric markets (e.g. Taiwan = ~6% YES / ~93% NO):** the split is
lopsided — the NO BUY quote alone can lock ~93% of your capital. If you have
$100 Limitless and quote `order_size: 100` on Taiwan, your $93 NO BUY fills
fine but a second tick before it cancels would overcommit. Either size down
or pick a more balanced market.

### Funding split

| Side | Chain | Asset | Why |
|---|---|---|---|
| Limitless | Base (8453) | USDC | Collateral for resting limit orders |
| Limitless | Base | ETH | Gas for approvals (one-time per market, ~$0.10-1) + occasional |
| Polymarket | Polygon (137) | USDC | Collateral for FAK hedge orders |
| Polymarket | Polygon | MATIC | Gas for hedges (~$0.01/tx) |

**Critical for migrated Polymarket accounts:** the Polymarket UI shows you a
specific address. With `poly_signature_type: 3` (new deposit wallet), funding
sent to your OLD Safe address will not be visible to the bot — it'll sit
idle. Verify the address before funding.

## Going live

```bash
# Step 0: re-read "Capital math" above. Pick order_size that fits your funding.
# Step 1: confirm DRY_RUN is clean for at least 5 minutes on your pair.
# Step 2: flip:
DRY_RUN=false npm run replicator
```

The boot sequence now runs both auth probes:

- **Limitless:** the SDK lazily fetches your profile when the first order is
  signed. Errors here = bad HMAC token (`LMTS_TOKEN_ID` / `LMTS_TOKEN_SECRET`)
  or, if you're on the legacy path, a revoked `LIMITLESS_API_KEY`.
- **Polymarket:** `createOrDeriveApiKey()` runs before quoting starts.
  `Polymarket auth probe failed` = wrong `poly_signature_type` (flip 2 ↔ 3)
  or wrong `poly_funder`.

First-fill expectations:

- Your quotes rest on the Limitless book. Fills happen when a Limitless
  taker hits you. **There's no guarantee anyone will take your quote** —
  illiquid pairs can rest for hours without action.
- The first taker fill triggers a hedge tick within `hedge_interval` seconds.
  Watch for the `HEDGE` log line followed by either `would hedgeBuy` (DRY_RUN)
  or an actual Polymarket order id.
- On a fresh Limitless market, the first `createOrder` will fail with
  "Market not approved." The bot doesn't auto-approve here — run
  `npm start approve <slug>` first.

## Scaling up for volume farming

The headline use of the replicator is **generating Polymarket volume** (every
hedge is a Polymarket FAK taker order → counts toward points / airdrop
eligibility). Each $1 of Limitless fill generates ~$1 of Polymarket volume on
the hedge side.

### Honest per-round-trip economics

Default config example (Bronze Limitless tier, 100bps Poly FAK fee):

```
Gross spread captured:                        ~$1.00 per 100 shares
Limitless taker-side fee (300bps Bronze):     −$1.35
Polymarket FAK taker fee (~100bps avg):       −$0.54
─────────────────────────────────────────────
Net per round-trip:                           ≈ −$0.89   ( ~−89 bps notional )
```

**Default config is a slight net loss.** Levers to flip positive:

| Lever | bps swing | How |
|---|---|---|
| Limitless tier (Bronze → Silver / Gold / Diamond) | +40 / +85 / +180 | Volume-gated. Diamond flips this fully positive. |
| Limitless maker rebate program | +200-400 typical | Per-market eligibility. Biggest single lever. See [docs.limitless.exchange/user-guide/maker-rebates](https://docs.limitless.exchange/user-guide/maker-rebates). |
| `margin_bps` 100 → 200 | +50-100 | Fewer fills but profitable when they happen. |
| Pair selection | +30-150 | Look for pairs where cross-venue spread > fee stack. |

### Suggested progression

| Phase | Duration | Config | Goal |
|---|---|---|---|
| 0. DRY_RUN | 30-60 min | `order_size: 100`, `margin_bps: 100`, 1 pair | Validate end-to-end. |
| 1. Tiny live | 1-2 hours | `order_size: 20`, `margin_bps: 100`, 1 pair | Confirm fills + hedges execute. ~$5-15 in fees as smoke-test cost. |
| 2. Single pair scale | 1-2 days | `order_size: 100`, `margin_bps: 150`, 1 pair | Measure real fill rate + cost/RT. Apply for maker rebate after day 1. |
| 3. Multi-pair production | ongoing | `order_size: 100-200`, `margin_bps: 150-200`, 3-5 pairs | Once maker rebate or tier upgrade lands, this is where farming compounds. |

For $2k / $2k funding: comfortable Phase 3 config. For sub-$100, stay in
Phase 1.

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
- Skips the Limitless portfolio read inside the hedger (no authed API call).
- Cancel / place / hedge all short-circuit to a `[DRY_RUN] would …` log line.
- All reads (markets, Polymarket positions, WS book) still happen — config is
  end-to-end validated.

This is the right way to start. Watch the log for a few minutes, sanity-check
the quote prices and hedge directions, then flip the bit.

## Troubleshooting

### `Market not found for slug: …`
The slug in `market_pairs:` doesn't exist on that venue. Run
`npm run replicator:find-pairs` and re-paste.

### `Polymarket auth probe failed`
Wrong `poly_signature_type` for your wallet, OR `poly_funder` doesn't match the
address your Polymarket UI shows. Flip `poly_signature_type` between 2 and 3.
Verify `poly_funder` literally matches the address in Polymarket's UI.

### `Invalid or revoked API key` / `401` (Limitless)
Your Limitless auth is being rejected. Limitless's current auth method is a
**scoped HMAC token**.
- **Get/refresh the token from the UI:** limitless.exchange → connect wallet →
  API token modal → "API Tokens" tab → Derive → copy the `tokenId` + `secret`
  into `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`. The SDK signs every request with
  HMAC automatically.
- **If you're on a legacy `LIMITLESS_API_KEY`:** note Limitless only keeps
  **one active key per account** — generating a new one in the UI silently
  revokes the old one. A `401` usually means the key in your `.env` was
  superseded. Switch to an HMAC token (above) to avoid this entirely.

In DRY_RUN this only shows up when polling Limitless positions — the hedger
now skips that call in DRY_RUN so you can develop without it. But you'll hit
this at LIVE boot, when the SDK tries to fetch your profile to place an order.

### `Market not approved` at first live createOrder
Each Limitless market requires a one-time USDC + CTF approval. The replicator
doesn't auto-approve. Run:
```bash
npm start approve <limitless-slug>
```
Then re-launch the replicator.

### Quotes rest forever, no fills
Two possible causes:
- The pair is illiquid on Limitless. Other takers aren't hitting your book.
  Pick a higher-volume pair or accept slow signal.
- Your `margin_bps` is too wide and your quotes are off-touch. Tighten it.

### `404` on Polymarket asset resolution
`polymarket_slug` is wrong. Polymarket has both *event* slugs and *market*
slugs; the replicator wants the **market** slug (one binary outcome per slug).
`find-pairs` prints the right one.

## Will this make money?

Be honest: **the bot is infrastructure, the strategy is your job.** Default
config (margin 100bps, Bronze fee tier 300bps on Limitless, FAK taker fee
~50–200bps on Polymarket) is a slight net loss per round-trip — see "Honest
per-round-trip economics" above. Real PnL requires one of:

1. **Limitless maker rebate program** — per the link above. Eligibility
   varies by market; biggest single lever.
2. **Higher Limitless fee tier** — Silver → Gold → Diamond, gated on volume.
3. **Edge in pair selection** — wider cross-venue spread > fee stack.
4. **Wider `margin_bps`** — fewer fills but each one profitable.

The dual-purpose use is volume farming for Polymarket points, where the
fee cost is treated as the entry ticket. See "Scaling up for volume farming"
above.

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
