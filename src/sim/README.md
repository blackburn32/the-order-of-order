# Balance simulation

A headless bot that plays full runs of The Order of Order to gather balance
statistics — win rates, where runs die, what gets bought, and how likely each
gated item is to unlock during play — and writes a self-contained HTML report.

The bot reuses the game's real economy end to end (`scoreRoll`, `applyOffer`,
`applyRoundStart`, the shop) through a shared round-loop engine (`engine.ts`) that
`GameScene` also uses, so results reflect the live rules rather than a re-implementation.

## Run it

```bash
npm run sim                      # defaults from config.ts → sim-out/report.html
npm run sim -- --runs=5000       # more runs = tighter numbers (slower)
npm run sim -- --seed=42         # reproducible; same seed → same report
npm run sim -- --maxDice=5000    # higher-fidelity dice cap (slower)
npm run sim -- --out=sim-out/base-only.html
```

Open the resulting `sim-out/report.html` in any browser (no server needed).

## Strategies compared

Each batch runs three shoppers over identical run counts:

- **No-buy** — never buys; the raw survival floor.
- **Random** — buys affordable offers in random order.
- **Greedy** — buys the most expensive affordable offer first.

## Configuring the run — `config.ts`

`DEFAULT_CONFIG` holds the knobs; CLI flags override `runs`, `seed`, `maxDice`, `out`.

**`unlockedAtStart`** is the editable "which items are unlocked before the test"
list — it seeds the shop pool. It defaults to every gated item ("all unlocked").
Edit it to test a narrower pool:

```ts
unlockedAtStart: []                       // base items only
unlockedAtStart: ['dividend', 'momentum'] // base + two candidates
```

This only changes what the shop *offers*. Unlock likelihood is measured for **all**
gated items regardless, so you always see how reachable each card's unlock is.

**`maxDice`** caps the dice pool (grid-growing builds otherwise explode). Winning
builds overshoot the round target by 100×+, so the cap barely moves win/loss —
but it must stay **above the largest `diceInGrid` unlock threshold** (Double the
Fun, `> 1000`) or that unlock reads as an artifactual 0%. The runner warns if it
doesn't. Default 2000 clears it with margin.

## Files

| File | Role |
|------|------|
| `engine.ts` | Pure round-loop rules shared with `GameScene` (roll → score → grow, round-end win/lose/advance). |
| `bot.ts` | Strategies, die-target selection, `simulateRun`, per-run unlock tracking. |
| `stats.ts` | Aggregates `RunRecord[]` into the report's numbers. |
| `report.ts` | Renders `BatchStats` to one self-contained HTML file (inline SVG charts). |
| `config.ts` | `DEFAULT_CONFIG` + the editable `unlockedAtStart`. |
| `localStorageShim.ts` | In-memory `localStorage` + seeded `Math.random` for Node/reproducibility. |
| `runBatch.ts` | CLI entry (`npm run sim`). |
