---
name: limitless-group-scan
description: Scans the child markets of a Limitless market group against each other and flags pricing that is internally inconsistent, such as mutually exclusive outcomes whose probabilities do not sum to one or date laddered markets whose probabilities move the wrong way, then proposes the corrective orders. Use when the user asks about a market group, an event with several outcomes, relative value between related markets, or whether a group is mispriced.
---

# Group consistency scan

Markets inside a group are related, so their prices have to agree with each other. When
they do not, the disagreement is the trade. This skill finds the disagreement and prices
the correction.

## 1. Resolve the group

`search_markets` or `list_markets` return entries with `kind`. For `kind: group`, check
`hasOrderableMarkets` rather than `orderable`, then call `get_market_group` on the group
slug for the children.

Group slugs cannot be traded. Every order goes to a child slug from `markets[].slug`.

## 2. Classify the group before comparing anything

This is the step that makes the scan correct or nonsense. Read the child titles and the
group metadata, then decide which relationship holds:

**Mutually exclusive and exhaustive.** Exactly one child can resolve YES, and one must.
A football match winner group (home, away, draw) is the clear case. The YES prices should
sum to about 1.

**Date laddered.** Each child asks the same question with a later deadline, for example
"by June 30" then "by July 31". These are not exclusive. The correct check is monotonicity:
a later deadline can never be less likely than an earlier one.

**Independent.** Children that can resolve YES together, such as separate props on one
event. No cross-market identity holds. Report the prices and stop, there is no
inconsistency to find.

If you cannot tell which case applies, say so and stop. A sum-to-one check on a
non-exclusive group produces a confident, wrong answer.

## 3. Read live prices

`get_orderbook` on each child slug. Use `bestBid` and `bestAsk`, not `midpoint` alone. A
gap that only exists between midpoints is not tradeable, because you buy at the ask and
sell at the bid.

**An empty book reports a midpoint of 0.5.** This is the single most likely way to
hallucinate an edge here. A child with no resting orders still returns `midpoint: 0.5`
with `bestBid` and `bestAsk` null, and the market summary price falls back near 0.5 too.
Sum three such children and you get 1.5, which looks like a 50 cent arbitrage and is
nothing at all. It happens routinely on groups whose event has effectively concluded but
whose book has emptied out.

Rule: a child only enters the calculation when `bookState` is `two_sided` and both
`bestBid` and `bestAsk` are non-null. Drop every other child and say which ones you
dropped and why. If fewer than all the children survive, the identity does not hold and
there is nothing to check.

## 4. Check

**Exclusive group:** sum the YES asks. Sum well above 1 means the set is collectively
expensive. Sum well below 1 means buying every outcome costs less than the $1 that one of
them is guaranteed to pay.

**Date ladder:** walk the children in deadline order. Flag any pair where the later
deadline prices below the earlier one.

Before calling anything an inconsistency, subtract the costs:

- the spread on every leg, since you pay the ask on each
- taker fees on any leg you cross for, `place_orders` returns the estimate per order
- whether every leg actually has size at the quoted price, check the book depth

Most apparent gaps are the spread. Say that plainly when it is the case, and do not dress
a spread up as an edge.

## 5. Propose

If a real gap survives step 4, build the correction as one `place_orders` call, one order
per leg, up to 10 legs. Show the legs, total cost, and the payoff if the group resolves as
the identity implies.

Hand over the `approvalUrl`, note the 10 minute expiry, poll `check_order_status`.

Partial fills break the identity. Say so before the user approves: legs are separate
orders and there is no guarantee they all fill. A half filled correction is a directional
position, not an arbitrage.

## Note on sports groups

Match winner groups are the most common exclusive groups on the platform. They are also
the case where a group scan is most likely to be arithmetic on a live scoreline rather
than a real pricing gap. Check the market metadata for an in-progress event before
treating a lopsided price as an error.
