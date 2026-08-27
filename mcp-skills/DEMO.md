# Demo and test script

One pass through all five skills. Run it as the acceptance test first, then film the same
sequence. Every step lists what a working run looks like, so a failure is unambiguous.

Prerequisite: the connector is authenticated and the selected Limitless Wallet is funded.
Budget for the full run is about $60.

## Market selection

Reward paying markets are currently the short window crypto up or down markets. Sorted by
LP rewards, the top of the book is BTC, ETH, SOL, BNB, XRP, DOGE and gold, on 5 minute,
15 minute and hourly cadences. Longer dated markets in the active feed are mostly sports
and esports, and those carry no daily reward budget.

| Demo | Market | Why |
|---|---|---|
| LP ladder | **BTC or ETH Up or Down, 15 Min** | Minimum 50 shares and a 0.035 band, so a rung costs roughly $12 at a 0.25 price. Rewards are sampled every 10 seconds on short window markets, so `isEarning` turns over inside the take. |
| LP ladder, calmer take | **BTC Up or Down, Hourly** | Minimum 100 shares, more time before resolution, roughly $37 a rung at a 0.37 price. |
| Scale-in | any crypto or macro market with a deadline days out | Nothing to race. |
| Portfolio review | whatever the first two demos left behind | Reads better with real positions and resting orders. |
| Group scan | a non-sports group | See the refusal note below. |

Confirm the numbers on the day. Minimum size, band, and daily reward are set per market and
change.

## Run

### 1. Connection check

> what can you do on Limitless right now?

Expect: the model lists the connector tools. If it says it needs credentials or offers to
write code against the API, the connector is not connected.

### 2. Discovery

> find me the BTC up or down markets and show me the current book on the 15 minute one

Expect: `search_markets` then `get_orderbook`. The book shows `bestBid`, `bestAsk`,
`spread`, `bookState: two_sided`, and a `liquidityRewards` block with `adjustedMidpoint`,
`maximumDistanceFromMidpoint` and `minimumContracts`.

### 3. LP ladder, the main demo

> quote this market for LP rewards, $50 total

Expect, in order:

1. `get_market` confirming `liquidityRewards.enabled` is true
2. `get_orderbook` for the live band
3. `get_wallet_balance` and sizing against `availableForNewBuyOrders`
4. a ladder table where every rung is at least `minimumContracts` shares, inside the band,
   and worth at least $1
5. one `place_orders` call and an `approvalUrl`

Open the link on camera. The approval page shows the exact terms. Approve.

6. `check_order_status` returns `approved` with `orderIds`

Wait about two minutes, then:

> are those orders actually earning?

Expect `get_open_orders` and a per-rung `isEarning` readout. This is the beat that makes
the demo, because it is the model checking its own work rather than declaring success.

### 4. Scale-in

> I think this resolves yes. build me into it with $20 across five limit orders

Expect a five rung ladder, one `place_orders`, and a closing report with average entry
price, breakeven probability, max payout and max loss.

### 5. Portfolio review

> where am I right now?

Expect all four read tools, a balance line that separates locked collateral from available,
positions with concentration flagged, resting orders with `isEarning`, and a list of
proposed cancels that it does not execute without asking.

### 6. Cleanup

> cancel the ladder

Expect confirmation in chat, then `cancel_all_orders`, then a fresh `get_wallet_balance`
showing the freed collateral. No approval link, because cancels execute directly.

### 7. Group scan

> is this group priced consistently?

Expect the group classified before any arithmetic, children with empty or one sided books
dropped by name, and either a flagged inconsistency net of spread and fees, or a clear
statement that there is no gap. A clean "no edge here" is a pass.

## What to expect to go wrong

**Refusals.** The framing lands better on crypto and macro markets, where the activity is
plainly limit orders on an exchange. Sports and esports markets read as sports betting to
the model regardless of framing, and that is most of the long dated inventory. Pick crypto
markets for the take.

**Empty books.** A market with no resting orders returns `midpoint: 0.5` with null best bid
and ask. Skills should drop those. If one gets treated as a real price, that is a bug worth
reporting.

**Short window markets resolve mid demo.** A 15 minute market can settle while you are
talking. Have the hourly open as a fallback.

**Proposal expiry.** An `approvalUrl` is dead after 10 minutes. If a take runs long, the
model needs a fresh `place_orders`, not a retry of the old link.
