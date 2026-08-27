# Limitless MCP skills

Six skills that drive the Limitless connector from a chat client. No API keys, no private
key, no server, no code. Every order goes through a browser approval on limitless.exchange.

This is the other half of this repo. `src/strategies/` holds headless bots that run
unattended with an HMAC token and a `PRIVATE_KEY`. These skills run inside a conversation
and cannot place an order on their own.

| | Bot strategies (`src/strategies/`) | MCP skills (here) |
|---|---|---|
| Runtime | Node process you host | Chat client |
| Auth | Scoped HMAC token + `PRIVATE_KEY` | OAuth to your Limitless account |
| Order placement | Signs and submits directly | Proposes, you approve in the browser |
| Cadence | Every tick, unattended | When you ask |
| Good for | Continuous quoting, hedging, latency | Research, sizing, one-off entries, review |

## Setup

### 1. Connect the MCP server

Endpoint: `https://api.limitless.exchange/mcp`

**Claude Desktop or claude.ai:** add it as a custom connector, then sign in with the
Limitless account you trade from and grant the `trading` scope.

**Claude Code:**

```sh
claude mcp add --transport http limitless https://api.limitless.exchange/mcp
# then run /mcp and authenticate in the browser
```

The connector trades from your selected **Limitless Wallet**. That is the address
`get_wallet_balance` returns in `walletContext.selectedTradingWallet`, and the one to fund.
It is not your login wallet and not your embedded wallet.

### 2. Install the skills

**Claude Desktop or claude.ai:** run `./pack.sh` to build one zip per skill into `dist/`,
then go to Customize > Skills > + > Create skill > Upload a skill and upload each zip.
Code execution must be enabled on the account for skills to appear.

**Claude Code:** copy the folders.

```sh
cp -r limitless-* ~/.claude/skills/          # available everywhere
cp -r limitless-* .claude/skills/            # this project only
```

## The skills

| Skill | What it does |
|---|---|
| `limitless-trading` | The shared operating manual. Tool map, order rules, approval flow, wallet and fee model. The others assume it. |
| `limitless-lp-ladder` | Rests a ladder of quotes inside a market's reward band, then verifies the orders are actually earning and re-quotes on drift. |
| `limitless-thesis-builder` | Turns a view into a written falsifiable thesis: your probability first, then resolution criteria audit, edge against the executable price, and sizing. |
| `limitless-scale-in` | Splits a budget into a ladder of limit orders across a price band and reports cost basis and breakeven probability. |
| `limitless-portfolio-review` | Balance, locked collateral, positions, concentration, stale and non-earning orders, recent fills, then proposed cleanup cancels. |
| `limitless-group-scan` | Checks the children of a market group against each other for pricing that cannot all be true. |

Install `limitless-trading` alongside whichever strategy skills you use.

## What the connector can and cannot do

**Cannot place an order.** `place_orders` returns an `approvalUrl`. You open it, review the
exact terms, and submit. The proposal expires after 10 minutes. Up to 10 orders share one
approval.

**Can cancel immediately.** `cancel_order` and `cancel_all_orders` execute with no browser
step. The skills confirm in chat first.

**Cannot see your keys.** Trading authority comes from the OAuth grant on your account, not
from a key the model holds. Revoke it from your Limitless account at any time.

## Where this sits in the learning path

[Limitless Academy](https://academy.limitless.exchange) teaches the headless path: wire the
SDK as tools, run an agent loop, deploy it, and keep it from hurting you. This repo is the
reference agent for that track.

These skills are the chat runtime of the same material. No key handling, no deployment, no
loop to babysit, and an approval step on every order. Useful as the on-ramp before the bot
strategies, and useful on its own for research and position management.

## Real money

These skills propose real orders against real markets on Base. Read the resolution criteria
before approving anything, and check the numbers on the approval page rather than trusting
the table in the chat. Nothing here is financial advice.
