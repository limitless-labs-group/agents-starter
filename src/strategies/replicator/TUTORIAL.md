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

# 4. Dry run — watch it think, sign nothing
npm run replicator
#   Confirm: both markets resolve, Poly WS connects, cancel-replace fires
#   every tick. Ctrl-C stops and cancels everything.

# 5. Go live — small
#   set dry_run: false (and make sure DRY_RUN isn't set in .env), then:
npm run replicator
```

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

## Why pick a *liquid* pair

Quote inside a thin or skewed book and two things go wrong: nothing fills (no
counterparties on Limitless), and the legs are lopsided (a 7%-YES market locks
almost all your capital on one side). `find-pairs` filters for a live
Polymarket book with a tight spread and a balanced price (~0.1–0.9) so both
legs are real and fills actually happen.

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
