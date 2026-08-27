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

Roughly four minutes. **One skill on camera, `limitless-thesis-builder`**, on equity
markets, with `limitless-portfolio-review` as a short second act. The other four skills get
a sentence at the end and no screen time.

Equities are the right surface for three reasons. The framing problem disappears, because
"is NVIDIA higher tomorrow" is plainly a financial question. The viewer has a real prior,
unlike a Fed decision where most people just defer to the market, so the calibration step
is a genuine estimate rather than a shrug. And the daily single-name markets are plain
binaries, so there is no group or ladder structure to explain.

The demo runs two theses. One clears the costs and becomes a position. One does not and
gets declined. Both are needed.

### Beat 1, the vague view (about 30 seconds)

Open cold, no setup shown.

> I think NVIDIA is up tomorrow

The model restates it as a claim with a source and a deadline, then **asks for your
probability before it shows any price**. That refusal is the beat. If a price appears
first, the skill did not fire, restart the take.

Answer with a real prior out loud. "It's a coin flip, call it 50."

### Beat 2, the resolution audit (about 60 seconds)

This is the value moment, and on equities it has genuinely surprising content.

The market does not resolve on the NYSE close. It resolves on the **Pyth NVDA/USD feed**,
**strictly higher** than the **most recent prior trading day**, and the reference price is
already captured and printed in the description, $227.96504 at the last read.

Let the model spell out the three consequences: the oracle price at the resolution moment
can differ from the official closing print, a perfectly flat day resolves Down because
strictly means strictly, and "prior trading day" shifts across weekends.

Say the line: you thought you were trading NVIDIA, you are trading a specific oracle's
opinion of NVIDIA at a specific moment. Anyone who has been burned by a settlement
technicality will sit up.

### Beat 3, the number, and the fee nobody accounts for (about 60 seconds)

The book was 0.330 bid, 0.409 ask. The model prices at the ask, because that is what you
pay, then adds the part people skip: the **3.00% BUY taker fee**, charged in shares, so the
effective price is 0.409 / 0.97, about 0.422.

Your 50 against an effective 0.422 is a real edge, roughly 19% expected return per share.
Quarter Kelly on that is about 3.4% of bankroll.

Then the honest caveat, which is what makes it credible: the spread is 7.9 cents on a 37
cent midpoint. A book that wide is not a confident statement of what the market believes,
so the edge number is soft. Either the market knows something about tomorrow, or nobody is
quoting. You cannot tell which from the book, and the model should say so rather than
selling the 19%.

### Beat 4, the one it turns down (about 45 seconds)

Same question, different ticker.

> what about Tesla?

0.443 bid, 0.508 ask, effective 0.523 after fees. Against the same coin-flip prior that is
**negative**, about -4% per share. The model declines.

Do the third one if the take has room. SPY was 0.422 bid, 0.478 ask, effective 0.493, which
against a 50% prior is roughly fair and also not a trade.

Three tickers, one trade. That ratio is the demo. A tool that finds an edge in everything
you point it at is a tool nobody should trust with money.

Worth showing if it comes up naturally: Amazon, SpaceX and EQT were all quoted 0.01 against
0.99, which is no book at all. The model drops them rather than pricing them.

### Beat 5, the approval (about 45 seconds)

Back to NVIDIA. The model sizes it, proposes, and returns an `approvalUrl`. Cut to the
browser. The approval page shows the exact terms. Approve, cut back, `check_order_status`
goes to `approved`.

Say the line while the browser is on screen: it proposed, you approved, it never held a key
or moved a dollar by itself. That is the difference between this and every agent demo that
opens by pasting a private key into a `.env` file.

### Beat 6, where am I (about 20 seconds)

> where am I right now?

`limitless-portfolio-review`. Balance, collateral locked by resting orders, the new
position. Short. It exists to show the loop closes.

### Close (about 20 seconds)

Name the other four skills in one sentence and point at the repo. Do not demo them.

### Optional coda

These markets resolve the next day. A fifteen second follow-up showing the position
resolved, filmed a day later, costs nothing and closes the story.

## Markets, verified live

Re-check on the day. Books move, and three of these had no book at all.

**Daily single-name equities.** Pyth resolved, `takerDelayMs` 0, fee bearing, minimum 150
shares for LP rewards, $10 a day reward budget. Last read:

| Market | Bid | Ask | Effective after 3% fee | Verdict at a 50% prior |
|---|---|---|---|---|
| NVIDIA (NVDA) | 0.330 | 0.409 | 0.422 | real edge, about +19% per share |
| S&P 500 ETF (SPY) | 0.422 | 0.478 | 0.493 | roughly fair, no trade |
| Tesla (TSLA) | 0.443 | 0.508 | 0.523 | negative, about -4% per share |
| Amazon, SpaceX, EQT | 0.010 | 0.990 | n/a | no book, drop them |

Top of book depth on the live three ran $50 to $76, so keep demo size small.

**Other inventory worth knowing about.** Macro groups (`fed-decision-in-september`,
`august-unemployment-rate`, ECB) for a five way resolution audit. Weekly nested price
ladders on SPY, gold, BTC and ETH, which are the trap case for `limitless-group-scan`.
Longer dated single names like OpenAI IPO, Stripe next round valuation, and AST SpaceMobile
if you want a thesis with more than a day on it. BTC and ETH Up or Down on 15 minute and
hourly cadences are the only markets paying LP rewards, needed if you ever demo the ladder.

**Do not demo sports or esports markets.** The framing holds for equities, macro and crypto,
where the activity is plainly limit orders on an exchange. It does not hold for sports, and
no amount of prompt wording fixes that.

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
