// Export every strategy tree as CSV, for a tree / graph visualisation tool.
//
// One row per tree and one per card. A chain card (`kind` card, `gated` true)
// links through `parent_id` to the card whose purchase unlocks it, and a chain's
// root links to the tree's own row; a tree's branches (`kind` branch, `gated`
// true) link to the chain card that opens them — the tier-2 card, or the engine
// for an engine's fuel; its supports (`kind`
// support) are base-set cards and link straight to the tree row. Any tool that
// builds a hierarchy from an id / parent-id pair can so draw the whole forest.
// Cards the trees deliberately leave out hang off one last `outside` row, so the
// export accounts for the entire roster.
//
// Live cards read their title, text, price and rarity from the roster itself
// (systems/Items), with any proposed change from systems/ItemTrees laid over
// them; planned cards read theirs from the tree file. Nothing here is authored
// twice, so re-running after an edit to either file is the whole process.
//
// The trees are validated first; an invalid tree fails the export rather than
// writing a CSV that quietly draws the wrong shape.
//
// Run: npm run trees:csv                      → sim-out/item-trees.csv
//      npm run trees:csv -- --out=trees.csv

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newRun } from "../state/RunState";
import {
  describeCriterion,
  ITEMS,
  MARK_PLAIN,
  MARK_STRONG,
  MARK_STRUCK,
  type ItemDef,
  type UnlockCriterion,
} from "../systems/Items";
import {
  ITEM_TREES,
  OUTSIDE_TREES,
  PLANNED_CARDS,
  validateTrees,
  type CardChange,
  type CardId,
} from "../systems/ItemTrees";
import { PRICE_BANDS } from "../systems/Shop";

const COLUMNS = [
  "kind",
  "tree_id",
  "tree_name",
  "id",
  "parent_id",
  "tier",
  "status",
  "name",
  "description",
  "price_band",
  "base_price",
  "stack_pricing",
  "rarity",
  "unique",
  "cursed",
  "gated",
  "unlock",
  "notes",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, string | number | boolean>;

const problems = validateTrees();
if (problems.length > 0) {
  console.error("Item trees are invalid:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const LIVE = new Map<CardId, ItemDef>(ITEMS.map((item) => [item.id, item]));
// Card text that reads run state is rendered against a fresh run — the figure
// a player sees on their first sight of the card.
const FRESH_RUN = newRun();
const STRUCK_FIGURE = new RegExp(
  `${MARK_STRUCK}[^${MARK_PLAIN}]*${MARK_PLAIN} ?`,
  "g",
);

/** A card's printed text as plain prose: the struck "current" half of an
 *  upgrade figure is dropped, and the face marks around the rest removed. */
function plainText(desc: ItemDef["desc"]): string {
  const text = typeof desc === "function" ? desc(FRESH_RUN) : desc;
  return text
    .replace(STRUCK_FIGURE, "")
    .split(MARK_STRONG)
    .join("")
    .split(MARK_PLAIN)
    .join("");
}

const unlockText = (unlock: UnlockCriterion | undefined): string =>
  unlock ? describeCriterion(unlock).replace(/^Locked — /, "") : "";

const treeRowId = (treeId: string) => `tree:${treeId}`;

function treeRow(
  id: string,
  name: string,
  description: string,
  notes: string,
): Row {
  return {
    kind: "tree",
    tree_id: id,
    tree_name: name,
    id: treeRowId(id),
    parent_id: "",
    tier: "",
    status: "",
    name,
    description,
    price_band: "",
    base_price: "",
    stack_pricing: "",
    rarity: "",
    unique: "",
    cursed: "",
    gated: "",
    unlock: "",
    notes,
  };
}

/** A chain card or branch has a parent, null for a chain's root; a support has
 *  none. */
type PlacedCard = { id: CardId; change?: CardChange; tier: number } & (
  { kind: "card" | "branch"; parent: CardId | null } | { kind: "support" }
);

function cardRow(treeId: string, treeName: string, node: PlacedCard): Row {
  const live = LIVE.get(node.id);
  const planned = live ? undefined : PLANNED_CARDS[node.id];
  const base = live
    ? {
        name: live.name,
        desc: plainText(live.desc),
        priceBand: live.priceBand,
        stackPricing: live.stackPricing ?? "none",
        rarity: live.rarity,
        unique: live.unique ?? false,
        cursed: live.cursed ?? false,
        unlock: unlockText(live.unlock),
      }
    : {
        name: planned!.name,
        desc: planned!.desc,
        priceBand: planned!.priceBand,
        stackPricing: planned!.stackPricing ?? "none",
        rarity: planned!.rarity,
        unique: planned!.unique ?? false,
        cursed: planned!.cursed ?? false,
        unlock: unlockText(planned!.unlock),
      };
  const change = node.change;
  const priceBand = change?.priceBand ?? base.priceBand;
  return {
    kind: node.kind,
    tree_id: treeId,
    tree_name: treeName,
    id: node.id,
    parent_id:
      (node.kind === "support" ? null : node.parent) ?? treeRowId(treeId),
    tier: node.tier,
    status: planned ? "planned" : change ? "changed" : "live",
    name: change?.name ?? base.name,
    description: change?.desc ?? base.desc,
    price_band: priceBand,
    base_price: PRICE_BANDS[priceBand],
    stack_pricing: change?.stackPricing ?? base.stackPricing,
    rarity: change?.rarity ?? base.rarity,
    unique: change?.unique ?? base.unique,
    cursed: change?.cursed ?? base.cursed,
    gated: node.kind !== "support",
    unlock: base.unlock,
    notes: [planned?.mechanic, change?.note].filter(Boolean).join(" "),
  };
}

const rows: Row[] = [];
for (const tree of ITEM_TREES) {
  rows.push(
    treeRow(
      tree.id,
      tree.name,
      `Engine: ${tree.engine}`,
      `Excludes: ${tree.excludes}`,
    ),
  );
  for (const node of tree.nodes)
    rows.push(cardRow(tree.id, tree.name, { ...node, kind: "card" }));
  for (const branch of tree.branches)
    rows.push(
      cardRow(tree.id, tree.name, {
        ...branch,
        kind: "branch",
        parent: branch.parent ?? tree.nodes[1].id,
        tier: 2,
      }),
    );
  for (const support of tree.supports)
    rows.push(cardRow(tree.id, tree.name, { ...support, kind: "support" }));
}

const OUTSIDE_ID = "outside";
const OUTSIDE_NAME = "Outside the trees";
rows.push(
  treeRow(
    OUTSIDE_ID,
    OUTSIDE_NAME,
    "Live cards no tree claims: shared utilities, and cards proposed for retirement.",
    "",
  ),
);
for (const [id, placement] of Object.entries(OUTSIDE_TREES)) {
  const row = cardRow(OUTSIDE_ID, OUTSIDE_NAME, {
    id: id as CardId,
    kind: "card",
    parent: null,
    tier: 1,
  });
  rows.push({
    ...row,
    tier: "",
    gated: false,
    status: placement!.status,
    notes: placement!.note,
  });
}

/** RFC 4180: quote a cell that holds a delimiter, a quote or a line break. */
function cell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csv =
  [
    COLUMNS.join(","),
    ...rows.map((row) => COLUMNS.map((column) => cell(row[column])).join(",")),
  ].join("\n") + "\n";

const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const out = outArg ? outArg.slice("--out=".length) : "sim-out/item-trees.csv";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, csv);

for (const tree of ITEM_TREES) {
  const cards = [...tree.nodes, ...tree.branches, ...tree.supports];
  const planned = cards.filter((card) => !LIVE.has(card.id)).length;
  console.log(
    `${tree.name.padEnd(16)} ${tree.nodes.map((node) => node.id).join(" → ")}  ` +
      `+ ${tree.branches.length} branches, ${tree.supports.length} supports (${planned} planned in all)`,
  );
}
console.log(
  `${OUTSIDE_NAME.padEnd(16)} ${String(Object.keys(OUTSIDE_TREES).length).padStart(2)} cards`,
);
console.log(`\nWrote ${rows.length} rows to ${out}`);
