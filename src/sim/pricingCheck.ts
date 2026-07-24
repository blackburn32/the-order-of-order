// Fast invariants for the target-relative shop economy. This deliberately
// exercises the shared production resolver rather than duplicating its formula.

import assert from "node:assert/strict";
import { ROUND_TARGETS } from "../config";
import { newRun } from "../state/RunState";
import { ITEMS } from "../systems/Items";
import {
  PRICE_VARIANCE_MAX_BPS,
  PRICE_VARIANCE_MIN_BPS,
  priceFor,
} from "../systems/Shop";

const state = newRun();
const byId = new Map(ITEMS.map((item) => [item.id, item]));

function price(id: (typeof ITEMS)[number]["id"]): bigint {
  return priceFor(byId.get(id)!, state);
}

assert.equal(price("extra_die"), 0n, "Two Bricks must remain free");
assert.equal(price("twin"), 2n, "Strong items start at the round-1 minimum");
assert.equal(
  price("amplifier"),
  3n,
  "Build-defining items start at the round-1 minimum",
);

state.round = 6;
state.roll = 5;
assert.equal(price("twin"), 45n, "round-6 Strong first-shop example drifted");
state.roll = 15;
assert.equal(price("twin"), 35n, "late-shop discount example drifted");
state.roll = 5;
state.purchases.twin = 1;
assert.equal(price("twin"), 80n, "explosive repeat surcharge drifted");
state.purchases = {};
assert.equal(
  priceFor(byId.get("twin")!, state, PRICE_VARIANCE_MIN_BPS),
  35n,
  "Strong-item discount boundary drifted",
);
assert.equal(
  priceFor(byId.get("twin")!, state, PRICE_VARIANCE_MAX_BPS),
  55n,
  "Strong-item markup boundary drifted",
);
assert(
  priceFor(byId.get("twin")!, state, PRICE_VARIANCE_MAX_BPS) >
    priceFor(byId.get("amplifier")!, state, PRICE_VARIANCE_MIN_BPS),
  "adjacent price bands no longer overlap",
);

for (const item of ITEMS) {
  const fresh = newRun();
  let previous = -1n;
  for (let round = 1; round <= ROUND_TARGETS.length; round += 1) {
    fresh.round = round;
    fresh.roll = 5;
    const firstShop = priceFor(item, fresh);
    assert(firstShop >= previous, `${item.id} became cheaper in a later round`);
    fresh.roll = 15;
    assert(
      priceFor(item, fresh) <= firstShop,
      `${item.id} became more expensive at the late checkpoint`,
    );
    previous = firstShop;
  }

  if (item.id !== "extra_die") {
    assert(priceFor(item, fresh) > 0n, `${item.id} unexpectedly became free`);
  }
}

console.log(
  `Pricing check passed for ${ITEMS.length} items across ${ROUND_TARGETS.length} rounds.`,
);
