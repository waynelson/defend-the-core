// The free supply depot: just the basics, one kit per barrel, and how the
// barrels stand in the depot's columns (two barrels high). Everything else
// is bought on Market Street.
//
// Item entries are [id, count, enchantments?]. Counts above an item's stack
// size spill into more slots; a barrel holds 27.

/** @type {{id: string, label: string, items: [string, number, Record<string, number>?][]}[]} */
export const KITS = [
  { id: "cobblestone", label: "Cobblestone", items: [["minecraft:cobblestone", 64 * 27]] },
  { id: "dirt", label: "Dirt", items: [["minecraft:dirt", 64 * 27]] },
  { id: "torches", label: "Torches", items: [["minecraft:torch", 64 * 27]] },
  {
    id: "workshop",
    label: "Workshop",
    items: [
      ["minecraft:crafting_table", 16],
      ["minecraft:furnace", 16],
      ["minecraft:coal", 64 * 2],
    ],
  },
  {
    id: "enchanting",
    label: "Enchanting",
    items: [
      ["minecraft:enchanting_table", 1],
      ["minecraft:bookshelf", 15],
      ["minecraft:lapis_lazuli", 64 * 2],
      ["minecraft:experience_bottle", 64 * 3],
      ["minecraft:anvil", 2],
      ["minecraft:grindstone", 1],
      ["minecraft:book", 32],
    ],
  },
];

/** The depot's eleven columns, in CHEST_SPOTS order: [bottom kit, top kit?].
 * The back row (the first five) stays empty: it's the way through to
 * Market Street. */
export const COLUMNS = [
  [], [], [], [], [],
  ["cobblestone", "dirt"],
  ["cobblestone", "dirt"],
  ["torches", "workshop"],
  ["cobblestone", "dirt"],
  ["cobblestone", "dirt"],
  ["torches", "enchanting"],
];
