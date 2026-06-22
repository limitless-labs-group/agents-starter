# program.md — autonomous market-making experiment loop

You are an agent running **research on how to market-make**, not a trader. You do
**not** predict odds and you do **not** decide trades by reasoning. A deterministic
bot does the quoting, hedging, and risk enforcement with hard limits. Your job is to
find the **circumstances** that make the cleanest, lowest-bleed hedged runs: which
pair, what spread, what size, how close to the event.

This is the prediction-market analogue of an autoresearch loop. The bot + hedger +
risk code are **fixed infra** (do not edit them). You edit **one file**,
`strategy.knobs.json`, run a bounded experiment, score it, keep or revert, repeat.

## The metric (higher is better)

`npm run cross-market-mm:score` reads a run and prints a single score plus its
components. It rewards: every fill hedged, the book staying delta-flat, some real
fills, little bleed, low peak inventory, and no manual rescue. A run with **no fills
is INCONCLUSIVE** (it tested nothing) — not a high score. Optimize the components it
prints, not the bare number.

## The loop (one experiment at a time)

1. **Read the record.** `cat <dataDir>/experiments.ndjson` (the log of past
   experiments + scores). If it is empty, start from the defaults already in
   `strategy.knobs.json`.
2. **Form one hypothesis.** Change **exactly one** knob in `strategy.knobs.json`
   (or pick a different pair) that you expect to raise the score. One change per
   experiment, so the score delta is attributable.
3. **Run a bounded experiment** with those knobs:
   - `npm run cross-market-mm:find-pairs` — pick a pair that fits the knob filters.
   - `npm run cross-market-mm:preflight` — must be all-green before anything live.
   - Run a bounded window: a **dry run** (`DRY_RUN=true SIMULATE_FILL=YES:6`) to
     check the quote+hedge pipeline, or a **small live pre-match window** for the
     real fill signal. **Pull before any match kicks off** (pre-match only).
4. **Score it.** `npm run cross-market-mm:score` — prints the breakdown and appends
   one line to `experiments.ndjson`. (`-- --interventions N` if you had to step in.)
5. **Keep or revert.** If the score beat the running best, keep the knob change;
   otherwise revert it. Either way the result stays in the log.
6. **Repeat.**

## Honesty rules (do not skip)

- **Markets are non-stationary.** A knob set that won Tuesday's match may lose
  Wednesday's. You are tracking the **currently good** conditions, not converging to
  one fixed optimum. Expect a **handful of real experiments a day** — one per match
  window — not 100 overnight. Parallelize across the day's matches, not across hours.
- **A run that never filled is inconclusive,** not a win. Resting quotes nobody hits
  proves nothing. Seek some fills before you trust a score.
- **Start dry, then tiny-live.** Size up only after a streak of clean live runs.
- **Never override the loss breaker or clear a pull/kill** without understanding why
  it tripped. The risk limits are not knobs.
- **You edit `strategy.knobs.json` only.** The bot is fixed infra.

## What "done for now" looks like

A short, current ranking in `experiments.ndjson` of which conditions hedge cleanly,
and the knobs file set to the best one you have found this session. Hand that to the
next run (or the operator) as the starting point.
