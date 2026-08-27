# Demo and test script

Two documents in one. The **film plan** is what to shoot. The **acceptance test** below it is
the full pass over all six skills, which you run once before filming and never on camera.

## Setup, do not film this

### Connector

Claude Desktop, Settings, Connectors, add a custom connector pointing at:

```
https://api.limitless.exchange/mcp
```

Sign in with the Limitless account you trade from and grant the `trading` scope. The
connector trades from your selected Limitless Wallet, which is what `get_wallet_balance`
returns as `walletContext.selectedTradingWallet`. Fund that address, not your login wallet.

Claude Code, for testing the same flow in a terminal:

```sh
claude mcp add --transport http limitless https://api.limitless.exchange/mcp
# then /mcp and authenticate
```

### Skills

Run `./pack.sh`, then on claude.ai go to Customize, Skills, the plus button, Create skill,
Upload a skill, and upload each zip from `dist/`. Code execution has to be enabled on the
account or the Skills surface does not appear. Skills uploaded there are available in
Claude Desktop on the same account.

**Verify skill and connector cooperate before you plan a shoot around it.** Open one
conversation, ask something that should trigger a skill, and confirm the model both loads
the skill and calls the connector tools. If that interop is awkward, fall back to a Project
with the skill text pasted into the project instructions. On camera the two are
indistinguishable, and the fallback has no upload step to go wrong.

## Film plan

Roughly four minutes. Two skills on camera, `limitless-thesis-builder` and
`limitless-group-scan`. The other four get a sentence at the end, not screen time.

The rule for every beat: it has to be something the viewer could not have done faster
themselves. Watching a model browse markets is not that. Watching it stop you from buying
the wrong market is.

### Beat 1, the vague view (about 30 seconds)

Open cold, no setup shown. Type something a person would actually say:

> I think the Fed holds in September

Expect the model to restate it as a claim with a threshold, a deadline and a source, then
**ask for your probability before it shows you any price**. That refusal to show the price
first is the beat. If it reports a price before asking, restart the take, because that is
the skill not firing.

Give a number out loud. Say 70%.

### Beat 2, the resolution audit (about 60 seconds)

The model searches, finds **Fed Decision in September**, and reads the criteria back. The
market resolves on the **upper bound of the target federal funds range** as decided at the
September FOMC meeting, and it has five outcomes rather than two: 50+ bps decrease, 25 bps
decrease, no change, 25 bps increase, 50+ bps increase.

This is the value moment. "Fed holds" is not a yes or no market here, it is one child of a
five way group, and the thing that decides it is a specific number in a specific statement.
Let that land before moving on.

### Beat 3, price and the honest answer (about 45 seconds)

The model prices it at the executable price, not the midpoint. On the day this was written
the "no change" child was 0.665 bid, 0.705 ask, so the market implied about 70% and the ask
is what you pay.

Your 70% against a 70.5% ask is no edge. The model should say there is no trade, and stop.

**Do not cut this.** A demo where the AI always finds a trade is a demo nobody believes. If
you want a positive outcome on camera too, give a second view where your number genuinely
differs from the book, and run the same beat again to a real position.

### Beat 4, the three reasons it is not free money (about 60 seconds)

Switch to the weekly Ethereum price ladder and ask the question a naive agent would get
wrong:

> there is a group here where the prices sum to about a dollar. is that free money?

**What price will Ethereum hit August 24-30** has 14 children, `↑ 3,100` down to `↓ 1,700`,
each resolving YES if any Binance 1-minute candle merely touches that level during the
window. The best asks summed to 0.985 at one read and 1.015 forty minutes later, so pull
fresh numbers on the day and expect them to have moved.

The model should decline, and the reason it gives is the beat. Three independent reasons,
any one of which is fatal:

1. **One child has no book.** 13 of the 14 have two sided books. You cannot buy a complete
   set that is missing a leg.
2. **The children are nested, not exclusive.** Touching 3,000 means you already touched
   2,900. The sum of a nested ladder has no reason to be 1, so being under 1 says nothing.
3. **The fee settles it before either of those.** Buying every leg means crossing the
   spread on every leg, and the published BUY taker fee is 3.00% for any outcome priced
   between $0.01 and $0.50, charged in shares. Every leg here is cheap, so the basket pays
   the full 3%, against an apparent gap of one or two points. Underwater before you start.

Reason 3 is the one worth saying out loud on camera, because it is the one a viewer can
check against the fee page and because it generalises: on this venue, cheap-leg basket
strategies start 3% behind.

Ask the follow up if the take has room:

> what about the ladder being inconsistent, is there anything there?

There are visible monotonicity inversions, for instance `↑ 2,900` asking less than
`↑ 3,000` when touching 2,900 is strictly easier. The correct answer is still no: those
inversions are fractions of a cent inside spreads of three cents on books that are one or
two orders deep. A violation smaller than the spread is not a violation.

An AI that talks you out of four bad trades in a row, with a different reason each time, is
a more useful demo than one that finds an edge.

### Beat 5, the approval (about 45 seconds)

Take the position from the second view in beat 3. The model sizes it, proposes, and returns
an `approvalUrl`. Cut to the browser. The approval page shows the exact terms. Approve it,
cut back, and the model polls `check_order_status` to `approved`.

Say the line out loud while the browser is on screen: the model proposed this, you approved
it, and it never held a key or moved a dollar on its own. That is the difference between
this and every agent demo that starts with pasting a private key into an env file.

### Close (about 20 seconds)

Name the other four skills in one sentence each and point at the repo. Do not demo them.

## Markets, verified live

Re-check these on the day. Minimums, spreads and depth all move.

| Market | Why it is good on camera |
|---|---|
| `fed-decision-in-september-1786349751858` | Macro, serious, five way group, all five children two sided. Resolution criteria are specific enough to make the audit beat land. Top of book depth runs from $1 to $70, so keep demo size small. |
| `what-price-will-ethereum-hit-august-24-30-1787554957657` | The nested threshold trap. 13 of 14 children two sided, best asks summed to 0.985, depth $14 to $463. |
| `august-unemployment-rate-1786349546297` | Nine children, all two sided, depth up to about $2,000. The backup if either of the above has thinned out. |
| BTC or ETH Up or Down, 15 Min or Hourly | The only markets currently paying LP rewards, needed for the ladder skill. They resolve fast, which is good for a reward demo and bad for anything slow. |

**Do not demo sports or esports markets.** The framing holds for crypto and macro, where the
activity is plainly limit orders on an exchange. It does not hold for sports, and no amount
of prompt wording fixes that. Macro and crypto inventory is easy to find through
`search_markets` even though the default active feed is mostly sports.

## Acceptance test

Run this once, off camera, before filming. About $60 of budget.

### 1. Connection

> what can you do on Limitless right now?

The model lists connector tools. If it offers to write code against the API instead, the
connector is not connected.

### 2. Discovery

> find the BTC up or down markets and show me the book on the 15 minute one

`search_markets` then `get_orderbook`. The book returns `bestBid`, `bestAsk`, `spread`,
`bookState: two_sided`, and a `liquidityRewards` block.

### 3. Thesis builder

> I think ETH ends the week higher. is that tradeable here?

Probability asked before price shown, several search phrasings, resolution audit that
rejects near misses out loud, price quoted from `bestAsk`, edge net of spread and fee, then
quarter Kelly sizing and a written thesis note with a falsifier.

### 4. LP ladder

> quote the 15 minute BTC market for LP rewards, $50 total

Every rung at or above `minimumContracts`, inside the band, worth at least $1. One
`place_orders`, one `approvalUrl`. Approve, then two minutes later ask whether the orders
are earning and expect a per-rung `isEarning` readout from `get_open_orders`.

### 5. Scale-in

> build me into it with $20 across five limit orders

Five rungs, one approval, closing report with average entry, breakeven probability, max
payout and max loss.

### 6. Portfolio review

> where am I right now?

All four read tools, locked collateral separated from available, concentration flagged,
proposed cancels that it does not execute without asking.

### 7. Cleanup

> cancel the ladder

Confirmation in chat, then `cancel_all_orders`, then a fresh balance. No approval link,
because cancels execute directly.

### 8. Group scan

Run it on the Ethereum ladder from beat 4 and confirm it declines for the right reason.

## What goes wrong

**Refusals.** Crypto and macro only. See the market table.

**Empty books.** A market with no resting orders returns `midpoint: 0.5` with null best bid
and ask. Skills drop those. If one gets treated as a real price, that is a bug.

**Short window markets resolve mid take.** A 15 minute market can settle while you are
talking. Keep the hourly open as a fallback.

**Proposal expiry.** An `approvalUrl` is dead after 10 minutes. A long take needs a fresh
`place_orders`, not a retry of the old link.

**Thin depth.** Top of book on the Fed children is as little as $1. Size the demo to the
book, or the fill will not match the table on screen.
