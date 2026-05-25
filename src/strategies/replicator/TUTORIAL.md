# Tutorial: a cross-venue LP bot for prediction markets

Build a bot that market-makes the **same** prediction market on two venues at
once: it mirrors Polymarket's live orderbook onto Limitless as resting BUY
quotes, and hedges any fills straight back on Polymarket. Net delta stays
~flat — you're earning the spread between the venues, not betting on the
outcome.

> Moves real money on two chains (Base + Polygon). This is a vibe-coded
> reference, not production infra. Use a **dedicated wallet** and start in
> `DRY_RUN`.

---

## The idea in one picture

```
Polymarket book  →  quote one margin step inside it on Limitless
   YES @ poly_bid - margin     (BUY)
   NO  @ (1 - poly_ask) - margin (BUY)
get filled on Limitless  →  BUY the offsetting side on Polymarket (FAK)  →  flat
```

You win the margin on every matched round-trip. The bot is intentionally
dumb: cancel all + re-quote on every Polymarket tick, no clever diffing.

## What you need first

1. A **dedicated** wallet (not your main). Same private key signs both venues.
2. Funds:
   - **Base**: USDC for Limitless collateral + a little ETH for gas.
   - **Polygon**: **pUSD** in your Polymarket account (the UI shows it as your
     cash balance) — this is what backs the hedge.
3. A **Limitless scoped API token** (HMAC). Get it from the UI: connect your
   wallet → API token modal → *API Tokens* tab → Derive → copy `tokenId` +
   `secret`. No smart wallet, no Privy token by hand.

## Steps

```bash
# 1. Install + secrets
npm install
cp .env.example .env && chmod 600 .env
#   set PRIVATE_KEY, LMTS_TOKEN_ID, LMTS_TOKEN_SECRET. DRY_RUN is already true.

# 2. Find a liquid, equivalent pair
npm run replicator:find-pairs
#   Prints a liquidity-ranked shortlist. Pick one where BOTH markets resolve
#   on identical criteria (same asset/threshold/time/source) — the script
#   ranks by a live, balanced Polymarket book, but YOU verify the wording.

# 3. Configure
cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
#   poly_funder          → the address Polymarket's UI shows (holds your pUSD)
#   poly_signature_type  → 3 deposit wallet (default) | 2 existing Safe
#   market_pairs         → paste your verified pair
#   order_size           → start tiny (e.g. 5)

# 4. Preflight — validate auth, funding, sig type, and the pair resolve
npm run replicator:preflight
#   Exits non-zero if anything's wrong, so this is a safe gate before live.

# 5. Dry run — watch it think, sign nothing
npm run replicator
#   Confirm: both markets resolve, Poly WS connects, cancel-replace fires
#   every tick. Ctrl-C stops and cancels everything.

# 6. Go live — small
#   set dry_run: false (and make sure DRY_RUN isn't set/true in .env), then:
npm run replicator
```

## Safety rails (built in)

- **Loss circuit-breaker** (`max_loss_usd`, default $10): the bot marks equity
  (pUSD + Base USDC + position value) every tick and, if it draws down past the
  limit, cancels all orders and halts. Set it to your tolerance before going live.
- **Boot-clean**: every live start cancels any orders left by a prior run before
  quoting, so orphans never accumulate.
- **Ctrl-C** cancels all resting orders (verified) on the way out.
- **`npm run replicator:flatten`** — manual kill switch: cancels all resting
  orders for your configured pairs (use if a run was killed ungracefully).

## What "working" looks like, live

```
INFO Polymarket auth OK                 { funder: 0xf6B5…, signatureType: 2 }
INFO Limitless market resolved          { yes: '2878…', exchange: '0x05c7…' }
INFO Polymarket assets resolved         { yes: '1146…', no: '6625…' }
INFO Poly WS connected                  { count: 2 }
INFO createOrder placed                 { side: 'YES', price: 0.61, size: 5, orderId: '…' }
INFO createOrder placed                 { side: 'NO',  price: 0.35, size: 5, orderId: '…' }
# …cancel-replace repeats on every Poly tick. On a fill:
INFO hedge filled                       { buyUsdc: '2.10' }
```

Ctrl-C → the bot cancels every resting Limitless order on the way out.

## Measuring it — is this actually good?

Every run writes a JSONL log to `./data/` (orders, per-tick exposure snapshots,
hedges) and prints a live `status` heartbeat. After a run, summarize it:

```bash
npm run replicator:analyze        # latest run in ./data
```

You get: orders placed, fills inferred from Limitless balance deltas, how flat
the book stayed (the health signal), and hedges fired. Use it to tell whether a
pair/margin combo actually fills and stays delta-neutral before trusting it.

## Why pick a *liquid* pair — and the catch

Quote inside a thin or skewed book and two things go wrong: nothing fills (no
counterparties on Limitless), and the legs are lopsided (a 7%-YES market locks
almost all your capital on one side). `find-pairs` filters for a live
Polymarket book with a tight spread and a balanced price (~0.1–0.9) so both
legs are real and fills actually happen.

**The real constraint: the pair must be liquid on _both_ venues at once.** You
make on Limitless (so you need Limitless _takers_ to get filled) and hedge on
Polymarket (so you need a Polymarket book to hedge into). As of this writing
the venues don't always overlap — e.g. Limitless's busiest markets are hourly
crypto "Up or Down", which Polymarket may not list, while a clean political
match can sit untraded on Limitless for hours. `find-pairs` ranks by the
Polymarket book; **also sanity-check the Limitless side has real recent volume**
(an empty Limitless book = your maker quotes rest forever, never filling). The
sweet spot is a market actively traded on both — that's when the spread is
actually capturable.

## Knobs

| Setting | What it does | Start at |
|---|---|---|
| `order_size` | contracts per side | `5` |
| `margin_bps` | how far inside Poly you quote (100 = 1%) | `100` |
| `hedge_threshold` | min net shares before hedging | `2` |
| `hedge_interval` | seconds between hedge checks | `5` |

## Safety

- `DRY_RUN` first, every time you change a pair or wallet.
- Dedicated wallet, small `order_size`, watch the first live minutes.
- Ctrl-C is your kill switch — it cancels all resting orders.
- Verify both markets resolve identically. Title match ≠ same market.
