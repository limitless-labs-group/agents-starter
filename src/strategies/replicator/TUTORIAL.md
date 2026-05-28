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
#   poly_funder          → your Polymarket DEPOSIT-WALLET address (see below),
#                          NOT a Gnosis Safe — the CLOB rejects Safe makers
#   poly_signature_type  → 3 (deposit wallet / POLY_1271) for new API accounts
#   market_pairs         → paste your verified pair
#   order_size           → start tiny (e.g. 5)

# 4. Preflight — validate auth, funding, sig type, exchange approval + pair
npm run replicator:preflight
#   Exits non-zero if anything's wrong (incl. a Safe funder or an
#   un-approved exchange), so this is a safe gate before live.

# 5. Approve the market's exchange (one-time, per exchange)
npm start approve <your-limitless-slug>
#   Limitless needs USDC (and, for selling, CTF) approved for the market's
#   exchange contract. Neg-risk markets (sports/election "winner" markets) use
#   a SEPARATE exchange, so they need their own approve. Preflight tells you
#   if it's missing.

# 6. Dry run — watch it think, sign nothing
npm run replicator
#   Confirm: both markets resolve, Poly WS connects, cancel-replace fires
#   every tick. Ctrl-C stops and cancels everything.

# 7. Go live — small
#   set dry_run: false (and make sure DRY_RUN isn't set/true in .env), then:
npm run replicator
```

### Polymarket account: use the deposit-wallet flow, not a Safe

Polymarket's CLOB will **reject orders from a Gnosis Safe** ("maker address not
allowed, please use the deposit wallet flow") — even though auth and balance
reads succeed from it. For programmatic/API trading you need Polymarket's
**deposit wallet** (a POLY_1271 smart wallet, signature type **3**).

One command sets it up (gasless — create a relayer API key in the Polymarket
builder dashboard, put it in `.env` as `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`):

```bash
npm run replicator:setup-poly
#   derives your deposit-wallet address, deploys it via the relayer, and
#   approves pUSD for the Polymarket v2 exchanges. Prints the address to set as
#   poly_funder (with poly_signature_type: 3). Then transfer your pUSD INTO that
#   deposit wallet — pUSD held elsewhere is not CLOB buying power.
```

`preflight` detects a Safe funder and fails fast, so you fix this before risking
a live run.

## Safety rails (built in)

- **Loss circuit-breaker** (`max_loss_usd`, default $10): the bot marks equity
  (pUSD + Base USDC + position value) every tick and, if it draws down past the
  limit, cancels all orders and halts. Set it to your tolerance before going live.
- **Boot-clean**: every live start cancels any orders left by a prior run before
  quoting, so orphans never accumulate.
- **Ctrl-C** cancels all resting orders (verified) on the way out.
- **`npm run replicator:flatten`** — manual kill switch: cancels all resting
  orders for your configured pairs (use if a run was killed ungracefully).
- **`npm run replicator:close`** — programmatic exit: SELLS all held YES/NO
  inventory back to flat (FAK at bid − slippage). The quoting loop is BUY-only
  and the hedger keeps you ~flat, but if a fill leaves you holding inventory
  this is how you wind down without waiting for resolution. (Selling needs the
  one-time exchange approval from step 5.)

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

### See the hedge fire without waiting for a live taker

Illiquid Limitless markets may not fill for a long time. To watch the full
fill→hedge round-trip end-to-end through the real pipeline (no real money):

```bash
SIMULATE_FILL=YES:5 DRY_RUN=true npm run replicator     # then Ctrl-C, then:
npm run replicator:analyze
```

It injects a synthetic 5-share YES fill on the first pair; the real hedger
detects the exposure, fires the offsetting NO hedge on Polymarket (logged in
dry-run), and the book returns to delta-flat — all recorded to `./data`. Handy
for demos and for sanity-checking the hedge math on a new pair.

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
crypto "Up or Down", which Polymarket may not list at the same window, while a
clean political match can sit untraded on Limitless for hours. `find-pairs`
ranks by the Polymarket book; **also sanity-check the Limitless side has real
recent volume** (an empty Limitless book = your maker quotes rest forever, never
filling). The sweet spot is a market actively traded on both — that's when the
spread is actually capturable.

### Where to actually look

There's no magic matcher — finding equivalent markets is a manual judgment call,
and `find-pairs` only does the first-pass ranking. Two categories overlap most
reliably:

- **Crypto price markets** — the short-window "Up or Down" / "above $X by <date>"
  contracts. The underlying is identical across venues, so these are the closest
  to truly equivalent. The catch is **timing and resolution**: confirm both sides
  use the same window (e.g. hourly vs 15-min), the same reference price/oracle,
  and resolve at the same instant. A 1h Limitless market and a 15-min Polymarket
  market on the same coin are _not_ the same trade.
- **Recurring macro / economic markets** — e.g. Fed rate decisions, CPI prints.
  These tend to be listed on both venues around the event and resolve on the same
  public number.
- **Sports finals, elections, tournament winners** — the deepest, most balanced
  cross-venue overlap (UCL/NBA/NHL champions, presidential/nomination winners).
  These are grouped/neg-risk markets — each candidate is its own YES/NO sub-market.
  `find-pairs` now enumerates these (it queries `tradeType=group` and flattens the
  per-candidate sub-markets), so they show up in the shortlist; **just confirm the
  exact candidate matches on both sides** (the matcher will pair the right market
  type with the wrong team/candidate if you let it).

Whatever you pick, **read both resolution criteria in full before trusting the
match** — same title is not the same market. Two traps the matcher won't catch:
a prop vs the winner ("reach final"/"top scorer" ≠ "win"), and the right market
with the wrong entity ("Italy to win" paired with "Spain to win").

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
