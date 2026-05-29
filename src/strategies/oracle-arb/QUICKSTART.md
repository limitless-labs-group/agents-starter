# Quickstart — oracle arb on Limitless

Stream sub-second crypto prices from [Pyth](https://pyth.network/developers/price-feed-ids)
(via Hermes SSE) and fire FOK orders on short-dated Limitless crypto markets when
the oracle disagrees with the book. Single venue, single chain (Base), SDK-only —
no Polymarket leg. Budget **~10 minutes**: install, fund, dry-run, go live.

> Real money on Base. Use a **dedicated** wallet, never your main. Starts in
> `DRY_RUN` (logs intents, signs nothing); set `DRY_RUN=false` only when you've
> watched a dry run and understand the edge below. Default bet is `$1`.

## What you need

- **One EOA private key** (`PRIVATE_KEY`) — signs orders on Base.
- **A Limitless scoped HMAC token** (`LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`) — not
  a wallet key. Full flow: [Limitless Authentication](https://docs.limitless.exchange/developers/authentication).
- **Funds on Base:** **USDC** (collateral) + ~$1–2 **ETH** (gas) on your EOA.

## 1. Install + credentials

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter && npm install
cp .env.example .env && chmod 600 .env
# set PRIVATE_KEY, LMTS_TOKEN_ID, LMTS_TOKEN_SECRET
```

## 2. Configure (optional — sensible defaults)

Everything is env-driven with defaults; you can run with none of these set. The
ones worth knowing:

```bash
ORACLE_ASSETS=BTC,ETH,SOL      # Pyth tickers to watch
ORACLE_MIN_EDGE=0.20           # min oracle-vs-market gap before trading (0..1)
ORACLE_MIN_PRICE=0.30          # don't buy below this — the book knows something
ORACLE_MAX_PRICE=0.65          # don't pay above this
ORACLE_BET_SIZE=1              # USD per trade
ORACLE_MAX_MINUTES=90          # only trade markets expiring within this window
```

See [SKILL.md](./SKILL.md) for the full table and what each one gates.

## 3. Dry run (see it work, risk nothing)

```bash
npm run oracle-arb
```

It connects to Hermes, scans Limitless crypto markets each tick, and logs any
`ORACLE EDGE: BUY` decisions it *would* place. Watch a few ticks: a healthy boot
logs `Hermes SSE connected`, your wallet USDC balance, and `Scan complete — no
opportunities` until the oracle and a market actually diverge. Edges are rare by
design — most ticks find nothing.

## 4. Go live

```bash
# .env: DRY_RUN=false
npm run oracle-arb
```

Live, it fires **FOK** (fill-or-kill) orders — they fill immediately at your
limit or cancel, so nothing rests. It **auto-approves** a market's exchange the
first time it trades there (USDC + CTF), so there's no manual approve step. It
skips trading entirely if your Base USDC balance is `$0`.

## 5. Operate + claim

```bash
npm run oracle-arb            # leave running; Ctrl-C to stop
npm run redeem claim-all      # redeem winnings after markets resolve
```

Open positions persist to `data/oracle-arb-positions.json`, so a restart won't
re-trade markets you're already in.

## What edge this has

The oracle gives you a fast, independent read on where a crypto price is relative
to a market's strike. When a short-dated market hasn't repriced to match, that gap
is the edge. Two honest caveats: the oracle-to-probability mapping is a heuristic
(not a calibrated model), and the `ORACLE_MIN_PRICE` floor exists because a market
pricing your side very cheap usually knows something a point-in-time oracle does
not. These are directional bets with no hedge — size with `ORACLE_BET_SIZE` and
treat `$1` as the learning size. You pay the Limitless
[taker fee](https://docs.limitless.exchange/user-guide/fees) on every fill (FOK is
always a taker). Full mechanics and tuning: [SKILL.md](./SKILL.md).
