# Balance simulation

A headless bot that plays full runs of The Order of Order to gather balance
statistics — win rates, where runs die, what gets bought, and how likely each
gated item is to unlock during play — and writes a self-contained HTML report.

The bot reuses the game's real economy end to end (`scoreRoll`, `applyOffer`,
`applyRoundStart`, the shop) through a shared round-loop engine (`engine.ts`) that
`GameScene` also uses, so results reflect the live rules rather than a re-implementation.

This includes dynamic shop pricing. Every simulated offer resolves its price from
the item's strength band, the current round target, whether the visit is the
roll-5 or roll-15 shop, how many copies have already been bought, and a fresh
−25%…+25% market adjustment. The report's item table therefore shows price bands
rather than a misleading single fixed cost. The shared rates, variance bounds,
and repeat-purchase factors live in `systems/Shop.ts`; item band and stacking
classifications live beside their effects in `systems/Items.ts`.

## Run it

```bash
npm run sim                      # defaults from config.ts → sim-out/report.html
npm run sim -- --runs=5000       # more runs = tighter numbers (slower)
npm run sim -- --seed=42         # reproducible; same seed → same report
npm run sim -- --out=sim-out/base-only.html
```

Open the resulting `sim-out/report.html` in any browser (no server needed).

## Strategies compared

Each batch renders five series over identical run counts:

- **No-buy** — never buys; the raw survival floor.
- **Random · base only** — buys one affordable offer, with no gated items unlocked.
- **Random · all unlocked** — the same policy with every gated item available.
- **Greedy · base only** — buys the most expensive affordable offer, with no gated items unlocked.
- **Greedy · all unlocked** — the same policy with every gated item available.

“Most expensive” means the concrete price at that shop visit, after target,
timing, repeat-purchase scaling, and market variance—not the item's abstract
strength band. It is intentionally an imperfect proxy for item value.

The base/all pair for each shopper uses the same seed stream so the comparison
does not pick up avoidable noise from unrelated rolls. Like the live game, each
shopper can buy at most one card per shop visit.

## Configuring auxiliary runs — `config.ts`

`DEFAULT_CONFIG` holds the knobs; CLI flags override `runs`, `seed`, `out`.

The main report always compares the `UNLOCK_POOLS.none` and `UNLOCK_POOLS.all`
pools. `DEFAULT_CONFIG.unlockedAtStart` remains available to auxiliary analysis
and validation scripts that run a single configured pool. Edit it to test a
narrower pool there:

```ts
unlockedAtStart: []; // base items only
unlockedAtStart: ["dividend", "momentum"]; // base + two candidates
```

This only changes what the shop _offers_. Unlock likelihood is measured for **all**
gated items regardless, so you always see how reachable each card's unlock is.

Grid-growing builds (Double the Fun, Genesis, multiply) let the dice pool grow
without bound; the sim runs the real scoring path over it, which stays cheap
because the pool flips to bucket mode (`O(buckets × faces)`, not per-die) once it
crosses the bucket threshold.

## Files

| File                  | Role                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `engine.ts`           | Pure round-loop rules shared with `GameScene` (roll → score → grow, round-end win/lose/advance). |
| `bot.ts`              | Strategies, die-target selection, `simulateRun`, per-run unlock tracking.                        |
| `stats.ts`            | Aggregates `RunRecord[]` into the report's numbers.                                              |
| `report.ts`           | Renders `BatchStats` to one self-contained HTML file (inline SVG charts).                        |
| `config.ts`           | `DEFAULT_CONFIG` + the editable `unlockedAtStart`.                                               |
| `localStorageShim.ts` | In-memory `localStorage` + seeded `Math.random` for Node/reproducibility.                        |
| `runBatch.ts`         | CLI entry (`npm run sim`).                                                                       |
