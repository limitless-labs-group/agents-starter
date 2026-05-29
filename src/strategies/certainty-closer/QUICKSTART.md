# Quickstart — certainty closer on Limitless

The simplest strategy in the repo, and the best place to learn the engine. Near a
market's resolution one side is often already the heavy favourite (trading at,
say, 0.92); this buys a small, Kelly-sized position in that side. Single venue,
single chain (Base), SDK-only — no price feeds. Budget **~10 minutes**.

> Real money on Base. Use a **dedicated** wallet, never your main. Starts in
> `DRY_RUN` (logs intents, signs nothing). Read the
> [edge note](#what-edge-this-has) before going live — on its own this has no
> independent edge.

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

Runs with no config set. The ones worth knowing:

```bash
CC_MIN_LEAD=0.85         # only buy favourites priced at least this
CC_MAX_LEAD=0.97         # ...and at most this (above it the return is too thin)
CC_MAX_MINUTES=30        # only markets resolving within this many minutes
CC_ASSUMED_EDGE=0.03     # YOUR asserted edge over the market — 0 means it won't bet
CC_MAX_RISK=2            # hard cap on $ risked per bet
CC_KELLY_FRACTION=0.25   # quarter-Kelly (smaller = safer)
```

`CC_ASSUMED_EDGE` is the whole game — see [below](#what-edge-this-has). Full table
in [SKILL.md](./SKILL.md).

## 3. Dry run (see it work, risk nothing)

```bash
npm run certainty-closer
```

Every 30s it scans the newest near-resolution CLOB markets, picks the favourite
side, Kelly-sizes a bet against your `CC_ASSUMED_EDGE`, and logs the candidates it
*would* buy. If you leave `CC_ASSUMED_EDGE=0`, the Kelly sizer correctly refuses
every bet — that's the intended default until you assert a real edge.

## 4. Approve + go live

This strategy does **not** auto-approve markets. Approve the exchange for any
market you intend to trade first (USDC for buying):

```bash
npm start approve <market-slug>
```

Then:

```bash
# .env: DRY_RUN=false  and  CC_ASSUMED_EDGE set above 0
npm run certainty-closer
```

It places **FOK** (fill-or-kill) buys a couple cents above the favourite's price,
sized by fractional Kelly and hard-capped at `CC_MAX_RISK`.

## 5. Operate + claim

```bash
npm run certainty-closer      # leave running; Ctrl-C to stop
npm run redeem claim-all      # redeem winnings after markets resolve
```

## What edge this has

Be straight about this one: **on its own it has no independent edge.** Buying the
favourite at 0.92 wins you 0.08 when you're right and loses 0.92 when the
"obvious" outcome flips. The crowd is usually right, but the payoff is thin and a
single upset erases many wins. The only edge is the one *you* assert via
`CC_ASSUMED_EDGE` — how much more certain than the market you believe the outcome
is. Set it to 0 (the default) and the Kelly sizer won't bet at all.

To make this real, replace the `CC_ASSUMED_EDGE` guess with an actual signal (an
oracle or data read that confirms the outcome) — at which point you've built
something closer to [oracle-arb](../oracle-arb/SKILL.md). Treat this as the
template that teaches the engine, not a money printer. You pay the Limitless
[taker fee](https://docs.limitless.exchange/user-guide/fees) on every FOK fill.
Full mechanics: [SKILL.md](./SKILL.md).
