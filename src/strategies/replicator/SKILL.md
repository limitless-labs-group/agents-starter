# Replicator — cross-venue market-making skill

Quote the **same** prediction market on two venues at once: mirror Polymarket's
live orderbook onto **Limitless** as resting BUY quotes, and hedge any fill
straight back on **Polymarket** so net delta stays ~flat. You earn the spread
between the venues (plus any Limitless maker rebate), not a directional bet.

This file is the canonical operating manual for the skill. An agent with shell
access and this file can take it from clone → dry-run → live → flat. For the two
fast paths, see **[QUICKSTART.md](./QUICKSTART.md)** (dry-run, <10 min) and
**[GO-LIVE.md](./GO-LIVE.md)** (real money, ~20–30 min). For the exact commands a
validation run uses, see **[DEMO.md](./DEMO.md)**.

> [!WARNING]
> **Moves real money on two chains** (Base + Polygon). This is a reference
> implementation, not production trading infrastructure. **Use a dedicated
> wallet**, keep `order_size` small, and always start with `DRY_RUN=true`. The
> default config is a slight net loss per round-trip — read "Economics" before
> expecting profit.

---

## 1. How it works

```
                      ┌────────────────────┐
   Polymarket WS ───▶ │  core/polymarket/  │  best bid/ask per slug → QuoteFeed
                      │  ws.ts             │  (everything in YES-frame)
                      └─────────┬──────────┘
                                │ updates wake the replicator
                                ▼
              ┌─────────────────────────────────────────────┐
              │  replicator/index.ts (one task per pair)    │
              │   • cancel ALL open Limitless orders        │
              │   • place YES BUY @ (poly_bid − margin)     │
              │   • place NO  BUY @ (1 − poly_ask) − margin │
              └─────────────────────────────────────────────┘
                                │ a Limitless taker fills a quote
                                ▼
              ┌─────────────────────────────────────────────┐
              │  replicator/hedger.ts (one task)            │
              │   • read net exposure on BOTH venues / 5s   │
              │   • if |net| > threshold:                   │
              │       FAK BUY the offsetting side on Poly   │
              └─────────────────────────────────────────────┘
```

Limitless is the maker side (where the spread is captured); Polymarket is the
hedge side (where directional risk is flattened, and where every hedge is a FAK
taker order that also generates Polymarket volume).

---

## 2. The wallet model — read this first

Everything is controlled by **one private key** (`PRIVATE_KEY`, your dedicated
EOA). That one key signs on both chains, but funds and identities live in a few
places. This is the single biggest source of setup confusion, so map it before
funding anything.

| Identity | What it is | Chain | Holds |
|---|---|---|---|
| **EOA** (your `PRIVATE_KEY`) | the key you control directly | Base + Polygon | Base USDC + ETH (Limitless side); signs everything |
| **Limitless** | trades from the EOA directly (EIP-712) | Base | — (uses the EOA's USDC) |
| **Polymarket deposit wallet** | a key-less ERC-1271 proxy derived from your EOA | Polygon | **pUSD** (the hedge collateral) |

Key facts that trip people up:

- **The Polymarket deposit wallet is key-less.** It's a deterministic CREATE2
  proxy (`POLY_1271`, signature type 3) whose only authorized signer is your
  EOA. You never get a separate private key for it — your `PRIVATE_KEY` controls
  it via ERC-1271 signature validation. `npm run replicator:setup-poly` derives
  and deploys it.
- **pUSD must live IN the deposit wallet.** Polymarket's CLOB v2 settles in
  **pUSD**, and your CLOB buying power is the pUSD balance *of the deposit
  wallet specifically*. pUSD sitting in your EOA, your Safe, or your Polymarket
  UI login address is **not** buying power — transfer it into the deposit wallet.
- **The deposit wallet is invisible in the Polymarket UI.** It's a different
  address from your Polymarket login, so the UI shows neither its balance nor
  its positions. Use `npm run replicator:status` (and the on-chain links it
  prints) to see them.
- **Existing Gnosis Safe users:** Polymarket's CLOB **rejects orders from a
  Safe maker** ("maker address not allowed, please use the deposit wallet
  flow"). Auth and balance reads succeed from a Safe, but orders don't — so even
  Safe users must move to the deposit-wallet flow (sig type 3) for this bot.

### Two API tokens (not on-chain keys)

| Token | For | Where from |
|---|---|---|
| **Limitless HMAC token** (`LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`) | scoped, signs every Limitless request | UI: connect wallet → API token modal → *API Tokens* → Derive |
| **Polymarket relayer key** (`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`) | gasless deposit-wallet deploy + approvals | Polymarket builder dashboard → relayer API key |

The Polymarket *trading* API key (used to place hedge orders) is **derived from
your `PRIVATE_KEY` signature at boot** — you don't create or store it. The
relayer key above is only for the one-time setup (deploy + approvals), which the
relayer pays gas for.

### The wiring order

```
setup-poly  →  fund  →  approve  →  preflight  →  run
```

1. **setup-poly** — derive + deploy the deposit wallet, approve pUSD (buy side)
   and CTF (sell side) on Polymarket's v2 exchanges.
2. **fund** — Base USDC + a little ETH on the EOA; pUSD transferred INTO the
   deposit wallet.
3. **approve** — Limitless exchange approval for your pair's market(s).
4. **preflight** — one command that re-checks all of the above and the pair.
5. **run** — dry-run, then live.

---

## 3. Commands

All from the repo root (`agents-starter/`). One-time setup commands are marked.

| Command | What it does |
|---|---|
| `npm run replicator:find-pairs` | Scan both venues; print a liquidity-ranked shortlist of equivalent market pairs as paste-ready YAML |
| `npm run replicator:setup-poly` | **(one-time)** Derive + deploy your Polymarket deposit wallet; approve pUSD (buy) + CTF (sell) on both v2 exchanges |
| `npm run replicator:preflight` | Validate auth, funding, sig type, exchange approvals, and pair resolution on both venues. Exits non-zero on any critical failure — use as a gate |
| `npm run replicator` | Run the bot (DRY_RUN by default). `DRY_RUN=false` to go live |
| `npm run replicator:status` | Read-only cross-venue portfolio view: Limitless USDC + positions/orders, deposit-wallet pUSD + positions, and per-pair net delta |
| `npm run replicator:close` | **Exit to flat:** cancel resting Limitless orders, then SELL held inventory on BOTH venues back to flat |
| `npm run replicator:flatten` | Cancel resting Limitless orders only (does not touch positions). Lighter recovery tool |
| `npm run replicator:analyze` | Summarize the latest run's JSONL log (orders, fills, how flat the book stayed, hedges fired) |
| `npm start approve <slug>` | **(one-time, per exchange)** Approve a Limitless market's exchange for USDC (buy) + CTF (sell) |

---

## 4. Setup

### 4.1 Install + secrets

```bash
npm install
cp .env.example .env && chmod 600 .env
```

Set in `.env`:

```
PRIVATE_KEY=0x...                 # dedicated trading EOA (NOT your main wallet)
LMTS_TOKEN_ID=...                 # Limitless scoped HMAC token id
LMTS_TOKEN_SECRET=...             # Limitless scoped HMAC token secret (base64)
RELAYER_API_KEY=...               # Polymarket relayer key (for setup-poly)
RELAYER_API_KEY_ADDRESS=0x...     # your signer EOA address (= PRIVATE_KEY's address)
DRY_RUN=true                      # keep true until you've watched a dry run
```

Get the **Limitless HMAC token** from the UI (the browser handles login, so you
never touch a Privy token and no smart wallet is involved):
limitless.exchange → connect wallet → API token modal → *API Tokens* tab →
Derive → copy `tokenId` + `secret`. Headless/CI: `npm run derive-token`.

Get the **relayer key** from the Polymarket builder dashboard.

### 4.2 Polymarket deposit wallet (one command)

```bash
npm run replicator:setup-poly
```

This is gasless (the relayer pays). It:
1. derives your deposit-wallet address,
2. deploys it via the relayer if it isn't already deployed,
3. approves **pUSD** (ERC-20 `approve`, the BUY side) AND **CTF**
   (`setApprovalForAll`, the SELL side) for Polymarket's v2 exchanges
   (`exchangeV2`, `negRiskExchangeV2`, `negRiskAdapter`).

Both approvals matter: pUSD-approve lets you place hedge BUYs, CTF-approve lets
`replicator:close` SELL the inventory back to flat. Skipping the CTF approval is
why an early close attempt left a naked Polymarket leg — the sell reverted with
allowance 0. setup-poly now does both and skips any already set.

It prints the deposit-wallet address. Put it in your config:

```yaml
poly_funder: "0x...the printed deposit-wallet address"
poly_signature_type: 3
```

### 4.3 Fund

| Side | Chain | Asset | Goes to | Why |
|---|---|---|---|---|
| Limitless | Base (8453) | USDC | your EOA | collateral for resting limit orders |
| Limitless | Base | ETH (~$1–2) | your EOA | gas for one-time approvals |
| Polymarket | Polygon (137) | **pUSD** | **the deposit wallet** | collateral for FAK hedges |

Transfer pUSD **into the deposit-wallet address** from 4.2 — not your EOA, not
your Safe, not your Polymarket UI login. `replicator:status` will show the
deposit wallet's pUSD so you can confirm it landed.

### 4.4 Configure the pair

```bash
npm run replicator:find-pairs          # prints paste-ready YAML
cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
```

Edit `replicator.config.yaml`: paste a verified pair into `market_pairs`, set
`order_size` small (start at `5`), confirm `poly_funder` + `poly_signature_type:
3`. **Verify both markets resolve on identical criteria** — same asset,
threshold, UTC moment, source. Title overlap is not enough (see §8).

### 4.5 Approve the Limitless exchange (one-time, per exchange)

```bash
npm start approve <your-limitless-slug>
```

Sends USDC→exchange (buy) and CTF→exchange (sell) approvals on Base. **Neg-risk
markets** (sports/election "winner" markets) use a *separate* exchange contract,
so a neg-risk pair needs its own approve. Preflight tells you if it's missing.

### 4.6 Preflight

```bash
npm run replicator:preflight
```

Re-checks Limitless HMAC auth + Base USDC, Polymarket auth + sig type +
deposit-wallet pUSD, the circuit-breaker setting, per-exchange USDC allowance on
Base, that the funder is API-tradeable (fails fast if it's a Gnosis Safe), and
that every configured pair resolves on both venues. Non-zero exit = don't go
live yet. `npm run replicator:preflight && npm run replicator` is the safe gate.

---

## 5. Dry run

```bash
npm run replicator          # DRY_RUN is the default
```

DRY_RUN signs and sends nothing: cancel/place/hedge each short-circuit to a
`[DRY_RUN] would …` log line, the Polymarket CLOB auth derivation is skipped,
and the hedger skips the authed Limitless position read. But all *reads*
(markets, Polymarket positions, WS book) still happen — your config is validated
end-to-end. A healthy boot resolves both markets, connects the Poly WS, and
fires a cancel-replace cycle within ~5s of `Poly WS connected`. If it doesn't,
the Poly book isn't quoting or your slug is wrong (see §7).

### See the hedge fire without a live taker

Illiquid Limitless markets may not fill for a long time. To watch the full
fill→hedge round-trip through the real pipeline (no real money):

```bash
SIMULATE_FILL=YES:5 DRY_RUN=true npm run replicator   # Ctrl-C, then:
npm run replicator:analyze
```

It injects a synthetic 5-share YES fill on the first pair; the real hedger
detects the exposure and fires the offsetting NO hedge on Polymarket (logged in
dry-run), returning the book to delta-flat. This is the demo of cross-venue
market-making that needs no Polymarket funding.

---

## 6. Go live and operate

```bash
# set dry_run: false in YAML AND ensure DRY_RUN isn't true in .env, then:
npm run replicator
```

Boot runs both auth probes before quoting, so a wrong sig type / funder / token
fails in ~2s instead of after fills accumulate. Every live start also cancels
any orders a prior run left resting, so the book starts flat.

**Monitor:**

```bash
npm run replicator:status      # cross-venue portfolio + net delta any time
```

`status` is the only place to see the deposit wallet's pUSD + Polymarket
positions (the UI can't show them) and the per-pair net delta (≈0 = hedged).

### Safety rails (built in)

- **Loss circuit-breaker** (`max_loss_usd`, default $10): marks equity (pUSD +
  Base USDC + position value) each tick; on a drawdown past the limit it aborts
  the run.
- **Flatten on stop** (`flatten_on_stop`, default **true**): a stop — Ctrl-C OR
  a tripped breaker — first cancels all resting orders, then **sells inventory
  to flat on BOTH venues**, so a stop never walks away with unhedged directional
  inventory. Cancelling orders alone isn't enough: a fill that already hedged
  leaves a position on each venue. Set `flatten_on_stop: false` only if you
  deliberately want to leave inventory in place.
- **Boot-clean:** every live start cancels prior resting orders before quoting.

### Manual exit to flat

```bash
npm run replicator:close
```

The deliberate wind-down. Per pair it cancels resting Limitless orders, then
SELLS held YES/NO inventory back to flat on **both** venues (Limitless: FAK at
bid − slippage; Polymarket: market FAK), and verifies 0 positions / 0 orphan
orders on both. It uses settled re-reads with a settle delay between sells so a
lagged balance can't trigger a re-sell of what already sold (the stale-read
double-fill bug). Idempotent — re-run if a thin book leaves a remainder.

`replicator:flatten` is the lighter tool: it only cancels resting orders and
does not touch positions. Use it when a run was killed ungracefully and you just
want a clean book.

---

## 7. Troubleshooting

### `Polymarket auth probe failed` / "maker address not allowed"
Wrong `poly_signature_type`, or `poly_funder` isn't the deposit wallet. The CLOB
**rejects Gnosis Safe makers** — even existing Safe users must use the
deposit-wallet flow. Run `npm run replicator:setup-poly`, set the printed address
as `poly_funder` with `poly_signature_type: 3`.

### Hedge BUY works but `replicator:close` SELL reverts ("not enough balance / allowance ... allowance 0")
Selling outcome tokens on Polymarket needs the **CTF `setApprovalForAll`**
(token side), which is distinct from the pUSD `approve` (cash side). Re-run
`npm run replicator:setup-poly` — it sets both. (This left a naked Poly leg once
this session; the fix is the CTF approval, then re-run close.)

### "isApprovedForAll returned no data (0x)" during setup-poly
A wrong CTF address — e.g. `0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB` is the
**Amoy testnet** ConditionalTokens, not Polygon mainnet. The correct Polygon CTF
is `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (already set in setup-poly).

### My pUSD / positions don't show up; CLOB says "insufficient balance"
pUSD must be **in the deposit wallet**, not your EOA / Safe / UI login address.
And only `@polymarket/clob-client-v2` trades pUSD — the old v1 client silently
fails against a pUSD-funded account. Run `npm run replicator:status` to see the
deposit wallet's actual pUSD balance and the polygonscan/data-api links.

### `Invalid or revoked API key` / `401` (Limitless)
Get/refresh the scoped HMAC token from the UI (API token modal → *API Tokens* →
Derive) into `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`. If you're on a legacy
`LIMITLESS_API_KEY`, note Limitless keeps **one active key per account** —
generating a new one in the UI silently revokes the old. Switch to an HMAC token
to avoid this. In DRY_RUN this only surfaces when polling positions (the hedger
skips that call in dry-run); live boot hits it when the SDK fetches your profile.

### `Market not approved` at first live `createOrder`
Each Limitless market needs a one-time USDC + CTF approval; the bot doesn't
auto-approve. Run `npm start approve <limitless-slug>`, then relaunch. Neg-risk
markets use a separate exchange and need their own approve.

### Close looks like it sold but the position is still there next read
Backend reads lag a fill. `replicator:close` already guards this with settled
re-reads + a settle delay; if you wrote a custom exit, re-read the *settled*
position before acting again, or a lagged read makes a filled order look killed
and you double-sell.

### Quotes rest forever, no fills
Either the pair is illiquid on Limitless (no takers hitting your book — pick a
higher-volume pair) or `margin_bps` is too wide and your quotes are off-touch
(tighten it). Remember you need liquidity on **both** venues at once (§8).
"Winner"/futures markets (championship, election) have deep books but little
minute-to-minute taker flow — your quote can sit at the touch for hours.
Higher-churn markets (actively-traded sports/crypto near an event) fill faster.

### Many `place_order failed` with `429` / "Too Many Requests" (Cloudflare 1015)
The Limitless API is IP-rate-limiting you. Cancel-replace fires every Polymarket
tick, and the Poly book ticks several times/sec, so an unthrottled run —
especially across multiple pairs — sends enough cancel+place calls to trip
Cloudflare. Symptoms: `place_order failed` count climbs, ticks log `replicate
tick failed`, quotes stop refreshing reliably (and a fill during a 429 window
could go un-hedged). The fix is the `min_requote_ms` floor (default 2000ms/pair)
— it coalesces bursts to one cancel-replace per interval while still quoting the
freshest book. Raise it or run fewer pairs if you still see 429s; lower it only
for a single pair you've confirmed stays under the limit. (Found the hard way on
a sustained 3-pair live run: ~7k orders in under 2h tripped the limit.)

### `place_order failed: Post-only order would execute immediately`
Your computed BUY price crosses the Limitless book (your bid ≥ the best ask), so
the post-only (maker) order is refused rather than taking. It means the two
venues are mispriced for that market — your Poly-derived quote is *through* the
Limitless touch. Harmless (the bot keeps quoting the other pairs); that pair just
won't rest a maker order until the books re-converge. It's also a signal the
cross-venue spread is inverted there — interesting, but the maker-only strategy
(invariant §9.1) won't take it.

### `404` on Polymarket asset resolution
`polymarket_slug` is wrong. Polymarket has *event* slugs and *market* slugs; the
bot wants the **market** slug (one binary outcome). `find-pairs` prints the right
one.

### `Market not found for slug: …`
The slug doesn't exist on that venue. Re-run `find-pairs` and re-paste.

---

## 8. Picking a pair

There's no magic matcher — finding equivalent markets is a manual judgment call,
and `find-pairs` only does the first-pass ranking (it gates on a live, balanced
Polymarket book + Limitless volume). **The real constraint: the pair must be
liquid on *both* venues at once** — you need Limitless *takers* to fill your
maker quotes, and a Polymarket book to hedge into.

Categories that overlap most reliably:

- **Crypto price markets** ("Up or Down" / "above $X by <date>"). Identical
  underlying, so closest to truly equivalent — but confirm the **same window**
  (hourly vs 15-min), same reference price/oracle, same resolution instant. A 1h
  Limitless market and a 15-min Polymarket market on the same coin are *not* the
  same trade.
- **Recurring macro/economic** (Fed decisions, CPI). Listed on both around the
  event, resolve on the same public number.
- **Sports finals, elections, tournament winners** (UCL/NBA/NHL champions,
  presidential/nomination winners). The deepest, most balanced overlap. These
  are grouped/**neg-risk** markets — each candidate is its own YES/NO sub-market;
  `find-pairs` enumerates them. Confirm the exact candidate matches on both sides.

Two traps the matcher won't catch: a **prop vs the winner** ("reach
final"/"top scorer" ≠ "win"), and the **right market with the wrong entity**
("Italy to win" paired with "Spain to win"). Read both resolution criteria in
full before trusting a match.

---

## 9. Capital math, economics, and invariants

### Capital locked

Each pair keeps two resting Limitless orders (YES BUY + NO BUY). Combined locked
capital ≈ `order_size × 1` USDC (the two prices sum to ~$1). So `order_size: 5`
≈ $5 locked per pair; `order_size: 100` ≈ $100.

**Asymmetric markets** (e.g. ~6% YES / ~93% NO) split lopsidedly — the NO BUY
alone can lock ~93% of capital. Size down or pick a balanced market.

### Economics — be honest

Default config (Bronze Limitless tier, ~100bps Poly FAK fee) is a **slight net
loss per round-trip**:

```
Gross spread captured:                    ~$1.00 / 100 shares
Limitless taker fee (300bps Bronze):      −$1.35
Polymarket FAK taker fee (~100bps):       −$0.54
─────────────────────────────────────────
Net per round-trip:                       ≈ −$0.89  (~−89 bps notional)
```

Levers to flip positive: **Limitless maker rebate program** (biggest single
lever — see docs.limitless.exchange/user-guide/maker-rebates), higher Limitless
fee tier (Silver/Gold/Diamond, volume-gated), wider `margin_bps` (fewer but
profitable fills), better pair selection (cross-venue spread > fee stack). The
dual-purpose use is **volume farming** — every hedge is a Polymarket FAK taker
order, ~$1 of Polymarket volume per $1 of Limitless fill — where the fee cost is
the entry ticket.

### Strategy invariants (load-bearing — re-derive the math before changing)

1. **Both Limitless quotes are BUY.** YES BUY at `poly_bid − margin`, NO BUY at
   `(1 − poly_ask) − margin`. Never SELL on Limitless while quoting.
2. **Cancel-all + replace every tick.** No diff optimizer; cancel+replace is
   cheaper than divergence risk.
3. **Hedge always BUYs on Polymarket.** Too much YES → BUY NO; too much NO → BUY
   YES.
4. **YES-frame is canonical** downstream of the WS listener (NO updates are
   inverted to `YES_ask = 1 − NO_bid`).

---

## 10. Tests and provenance

```bash
npm test
```

Unit tests cover the quote math (`clipPrice`, `computeBuyPrices`), the hedger
(`decideHedge` direction, notional, dust gate, cross-venue netting), the
recorder, and the risk monitor.

This is a TypeScript port of
[limitless-labs-group/limitless-replicator](https://github.com/limitless-labs-group/limitless-replicator)
(the Python original — the longer-form "everything visible" reference). Material
differences: the Limitless side uses `@limitless-exchange/sdk` (venue routing
automatic); the Polymarket side uses `@polymarket/clob-client-v2` (required —
Polymarket migrated collateral to pUSD on a V2 exchange and only v2 trades it);
and `poly_signature_type` (2 = Safe, 3 = deposit wallet) maps onto v2's
`SignatureTypeV2`. Same quote math, same hedge logic, same cancel-on-shutdown.
