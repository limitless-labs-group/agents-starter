# Certainty closer — the simplest Limitless strategy

Canonical operating manual. Any agent with shell + file access and this file can
take certainty-closer from clone → dry-run → live. For the fast path, see
**[QUICKSTART.md](./QUICKSTART.md)**.

This is the teaching template. It uses **only** the Limitless SDK (no external
feeds) to demonstrate the two things every strategy needs: filtering markets by
time-to-expiry, and the `BaseStrategy` tick → decision → execute loop. Near
resolution it buys a small, Kelly-sized position in the leading side.

> [!WARNING]
> **Moves real money on Base.** On its own this strategy has **no independent
> edge** (see §5). It exists to teach the engine and to be extended with a real
> signal. Use a dedicated wallet and start in `DRY_RUN`.

## 1. How it works

Each tick (every 30s):

1. **Scan** the 25 newest active CLOB markets (the markets API caps `limit` at 25;
   short-window markets surface at the top).
2. **Filter** to markets resolving within `[minMinutesToExpiry, maxMinutesToExpiry]`.
3. **Pick the favourite** — whichever of YES/NO is priced higher — and keep it
   only if its price is inside `[minLeadPrice, maxLeadPrice]`.
4. **Assert the edge.** `trueProb = price + assumedEdge`. This is the only edge in
   the strategy; you supply it.
5. **Size with Kelly** (`kellySize`): fractional-Kelly against your bankroll, hard
   capped at `maxRiskUsd`. If `assumedEdge` is 0, Kelly returns a zero bet and the
   market is skipped.
6. **Fire FOK** a couple cents above the favourite's price (capped at 99¢), up to
   `maxPositions` open at once.

Traded markets are tracked in memory for the run (not persisted), so it won't
double-buy the same market while running.

## 2. Auth + funding

- **Limitless:** `PRIVATE_KEY` (signs orders) + a scoped HMAC token
  (`LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`). Legacy `LIMITLESS_API_KEY` also works.
  See [Authentication](https://docs.limitless.exchange/developers/authentication).
- **Base:** USDC (collateral) + a little ETH (gas) on your EOA.
- No Polymarket, no second chain.

## 3. Configuration

All env-driven with defaults (set in `run.ts`):

| Env var | Default | What it gates |
|---|---|---|
| `CC_MIN_LEAD` | `0.85` | Min price on the leading side to consider it |
| `CC_MAX_LEAD` | `0.97` | Max price — above this the return is too thin |
| `CC_MIN_MINUTES` | `0` | Min time-to-expiry (0 = right up to expiry) |
| `CC_MAX_MINUTES` | `30` | Max time-to-expiry |
| `CC_ASSUMED_EDGE` | `0.03` | **Your** asserted edge over the market (0 = won't bet) |
| `CC_BANKROLL` | `50` | Bankroll the Kelly sizer sizes against (USD) |
| `CC_KELLY_FRACTION` | `0.25` | Kelly multiplier (0.25 = quarter-Kelly, safer) |
| `CC_MAX_RISK` | `2` | Hard cap on dollars risked per bet |
| `CC_MAX_POSITIONS` | `5` | Max concurrent positions |
| `DRY_RUN` | `true` | `false` to place real orders |

## 4. Commands

```bash
npm start approve <market-slug>   # one-time per exchange — see §6, no auto-approve
npm run certainty-closer          # run (DRY_RUN by default); Ctrl-C to stop
npm run redeem claim-all          # redeem winnings after markets resolve
```

## 5. Economics + edge

Buying a favourite at price `p` pays `1 − p` if it resolves your way and loses `p`
if it flips. At `p = 0.92` that's +0.08 vs −0.92: the crowd is usually right, but
one upset wipes out many wins, and FOK fills pay the Limitless
[taker fee](https://docs.limitless.exchange/user-guide/fees) on top. So the
break-even is entirely about whether your `assumedEdge` is real.

It usually isn't, by default — `assumedEdge = 0` means the sizer refuses to bet,
which is the honest resting state. The strategy becomes profitable only when you
replace that asserted number with a genuine signal (a data or oracle read that
confirms the near-resolution outcome). At that point you've effectively built a
feed-driven strategy — compare [oracle-arb](../oracle-arb/SKILL.md), which does
exactly that with Pyth.

## 6. Risk + invariants

- **No edge without a signal.** `assumedEdge = 0` ⇒ no bets. Don't crank it up to
  force trades; that just sizes bigger into a coin flip.
- **Fractional Kelly + hard cap.** Bets scale to the asserted edge but never
  exceed `maxRiskUsd`. Keep `kellyFraction` ≤ 0.25 while learning.
- **No auto-approve.** Unlike oracle-arb, this uses the base executor and will not
  approve exchanges for you. Approve a market's exchange (`npm start approve
  <slug>`) before live trading, or the order fails and is logged.
- **In-memory tracking.** A restart clears the traded set, so it may re-enter a
  still-open market.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Never bets (dry or live) | `CC_ASSUMED_EDGE` is 0, or no favourite is inside `[CC_MIN_LEAD, CC_MAX_LEAD]` in the window. Assert an edge and/or widen the band. |
| `not approved` / `allowance` on live | This strategy doesn't auto-approve. Run `npm start approve <slug>` for that market's exchange first. |
| No candidates found | Tighten nothing — widen `CC_MAX_MINUTES` or lower `CC_MIN_LEAD`; near-resolution markets are sparse. |
