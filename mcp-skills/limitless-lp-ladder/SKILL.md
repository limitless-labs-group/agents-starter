---
name: limitless-lp-ladder
description: Builds a ladder of resting limit orders on a Limitless market positioned to earn LP rewards, then verifies the orders are actually earning and re-quotes when the midpoint drifts. Use when the user wants to provide liquidity, market make, farm LP rewards, earn rewards on a Limitless market, or quote a book instead of taking it.
---

# LP reward ladder

Rest limit orders close enough to the midpoint, and large enough, to qualify for a
market's liquidity rewards. Ten rungs fit in one browser approval.

Reward mechanics: https://docs.limitless.exchange/user-guide/lp-rewards

**The risk is not the reward, it is the fill.** A resting bid is a real order. When it
fills you own shares and carry the outcome risk until resolution. Size the ladder as a
position you are willing to hold, not as a rebate farm.

## Workflow

```
- [ ] 1. Pick a market and confirm it pays rewards
- [ ] 2. Read the live book
- [ ] 3. Size against available balance
- [ ] 4. Build the ladder
- [ ] 5. Propose and hand over the approval link
- [ ] 6. Verify the orders are earning
- [ ] 7. Re-quote on drift
```

### 1. Pick a market and confirm it pays rewards

`search_markets` or `list_markets`, then `get_market` on the chosen slug. You need:

- `orderPlacement.orderable` is true
- `liquidityRewards.enabled` is true. When it is false the market has no active reward
  rules and this skill has nothing to do. Say so instead of quoting anyway.
- `liquidityRewards.minimumContracts`, the minimum shares per order to qualify
- `liquidityRewards.maximumDistanceFromMidpoint`, the reward band in price terms

Prefer markets with a deadline far enough out to be worth quoting. Short window markets
(5 minute, 15 minute, hourly) resolve while your orders are still resting.

### 2. Read the live book

`get_orderbook` on the same slug. Use `liquidityRewards.adjustedMidpoint` as the centre of
the band when it is present, and `midpoint` otherwise. Also note `bestBid`, `bestAsk`,
`spread`, and `bookState`.

If `bookState` is `empty` or `one_sided`, say so. There is no meaningful midpoint to quote
around and the ladder is guesswork.

### 3. Size against available balance

`get_wallet_balance`. Budget against `availableForNewBuyOrders`, not `formatted`, because
resting BUY orders already lock collateral.

Ask the user for a total budget if they have not given one. Never infer it from the
balance.

**Price the rung before promising a ladder.** One rung costs
`minimumContracts × your price`. Eligibility is set in shares, so the cost of qualifying
scales with the price of the outcome you quote:

| Outcome price | Minimum shares | Cost of one rung |
|---|---|---|
| 0.98 | 100 | $98 |
| 0.50 | 100 | $50 |
| 0.02 | 100 | $2 |

A six rung ladder on a market trading near 0.98 is a few hundred dollars of committed
collateral. If that exceeds the budget, say so and offer the cheaper outcome or a market
with a smaller `minimumContracts`, rather than quoting under the minimum and earning
nothing.

### 4. Build the ladder

Constraints, all of which must hold for every rung:

- distance from the reward midpoint is within `maximumDistanceFromMidpoint`
- `shares >= minimumContracts`
- `price × shares >= 1`
- `price` strictly between 0 and 1
- rungs total at or under the user's budget
- at most 10 rungs, since that is one approval

Default shape: 4 to 6 BUY rungs stepping away from the midpoint, all `GTC`, sized flat.
Closer to the midpoint earns a higher multiplier and fills sooner, so the tightest rung is
the most expensive one to be wrong about.

**Sides.** Quoting one side only earns while the market sits between 5% and 95%. Outside
that band a one-sided ladder earns nothing at all, no matter how tight it is. Even inside
the band, two-sided quoting scores better than one-sided for the same total size.

Two-sided on a binary market means resting on both YES and NO, or resting a SELL against
shares you already hold. Buying NO at 0.02 is the same book presence as selling YES at
0.98, and costs a fiftieth as much collateral. State which construction you are using and
what it costs on each leg.

### 5. Propose and hand over the approval link

`place_orders` with all rungs in one call. Give the user the `approvalUrl`, tell them it
expires in 10 minutes, and show the ladder as a table: price, shares, cost, distance from
midpoint. Then poll `check_order_status` with the returned `state`.

### 6. Verify the orders are earning

This is the step that separates a working ladder from a decorative one. Two minutes or so
after approval, call `get_open_orders` and check `isEarning` on each order.

`isEarning` false on every rung means the ladder is outside the band or under the minimum
size. Re-read `get_orderbook`, fix the offending constraint, `cancel_all_orders` on that
market, and propose a corrected ladder. Do not leave a non-earning ladder resting and
report success.

`isEarning` reflects the last persisted reward epoch, so give it a minute before judging.

### 7. Re-quote on drift

The midpoint moves and the band moves with it. On each check, re-read `get_orderbook`. If
the reward midpoint has moved so that rungs now sit outside
`maximumDistanceFromMidpoint`, cancel and re-propose.

`cancel_all_orders` executes immediately with no approval, so confirm with the user before
cancelling a ladder they approved.

## Reporting

Report the ladder as a position, not a yield:

- total collateral committed and what it buys if every rung fills
- average entry price if fully filled, and the implied probability that entry represents
- which rungs are earning
- what remains available for new BUY orders

Rewards accrue per minute and pay out daily at 22:30 UTC. Do not project an APR. The
market's reward budget, the band, and the minimum size all change over time, and your
share depends on everyone else's quotes.
