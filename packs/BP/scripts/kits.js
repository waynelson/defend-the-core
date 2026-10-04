// Starter kits for the supply depot, one per barrel, and how the barrels
// stand in the depot's eleven columns (two barrels high).
//
// Item entries are [id, count, enchantments?]. Counts above an item's stack
// size spill into more slots; a barrel holds 27. Potions use
// [id, count, {potion: data}] because stable script APIs can't make
// potions; they go in by `replaceitem`.

const POTION = {
  fire_resistance: 12,
  swiftness: 14,
  healing: 21,
  strong_healing: 22,
  regeneration: 28,
  strength: 31,
};

/** @type {{id: string, label: string, items: [string, number, Record<string, number>?][]}[]} */
export const KITS = [
  // (no armour: everyone's comes free with their Armor level)

  // ---- weapons and ammo: 16 sets
  {
    id: "melee",
    label: "Swords",
    items: [
      ["minecraft:diamond_sword", 2, { sharpness: 3, unbreaking: 2 }],
      ["minecraft:iron_sword", 14, { sharpness: 2 }],
      ["minecraft:iron_axe", 8, { sharpness: 1 }],
    ],
  },
  { id: "shields", label: "Shields", items: [["minecraft:shield", 16], ["minecraft:totem_of_undying", 2]] },
  {
    id: "ranged",
    label: "Bows",
    items: [
      ["minecraft:bow", 16, { power: 2, unbreaking: 1 }],
      ["minecraft:crossbow", 4, { quick_charge: 2 }],
    ],
  },
  {
    id: "ammo",
    label: "Ammo",
    items: [
      ["minecraft:arrow", 64 * 20],
      ["minecraft:fire_charge", 64 * 2],
      ["minecraft:snowball", 16 * 4],
    ],
  },

  // ---- building: dirt and cobblestone are free; the Mason sells the rest
  { id: "cobblestone", label: "Cobblestone", items: [["minecraft:cobblestone", 64 * 27]] },
  { id: "dirt", label: "Dirt", items: [["minecraft:dirt", 64 * 27]] },

  {
    id: "redstone",
    label: "Redstone",
    items: [
      ["minecraft:redstone", 64 * 3],
      ["minecraft:redstone_torch", 64],
      ["minecraft:repeater", 64],
      ["minecraft:comparator", 32],
      ["minecraft:piston", 32],
      ["minecraft:sticky_piston", 32],
      ["minecraft:observer", 32],
      ["minecraft:lever", 32],
      ["minecraft:stone_button", 32],
      ["minecraft:stone_pressure_plate", 32],
      ["minecraft:tripwire_hook", 32],
      ["minecraft:string", 64 * 2],
      ["minecraft:redstone_block", 32],
      ["minecraft:slime", 32],
      ["minecraft:hopper", 16],
    ],
  },
  {
    id: "traps",
    label: "Traps",
    items: [
      ["minecraft:dispenser", 64],
      ["minecraft:dropper", 32],
      ["minecraft:tnt", 64],
      ["minecraft:magma", 64],
      ["minecraft:soul_sand", 64],
      ["minecraft:honey_block", 32],
      ["minecraft:target", 16],
      ["minecraft:arrow", 64 * 4],
    ],
  },

  // ---- supplies
  {
    id: "food",
    label: "Food",
    items: [
      ["minecraft:cooked_beef", 64 * 4],
      ["minecraft:bread", 64 * 2],
      ["minecraft:baked_potato", 64 * 2],
      ["minecraft:golden_carrot", 64],
      ["minecraft:cooked_chicken", 64],
      ["minecraft:golden_apple", 16],
      ["minecraft:enchanted_golden_apple", 2],
      ["minecraft:cake", 2],
    ],
  },
  {
    id: "potions",
    label: "Potions",
    items: [
      ["minecraft:potion", 6, { potion: POTION.healing }],
      ["minecraft:potion", 3, { potion: POTION.strong_healing }],
      ["minecraft:potion", 4, { potion: POTION.regeneration }],
      ["minecraft:potion", 4, { potion: POTION.swiftness }],
      ["minecraft:potion", 4, { potion: POTION.strength }],
      ["minecraft:potion", 2, { potion: POTION.fire_resistance }],
      ["minecraft:splash_potion", 4, { potion: POTION.healing }],
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      ["minecraft:diamond_pickaxe", 2, { efficiency: 3, unbreaking: 2 }],
      ["minecraft:iron_pickaxe", 6, { efficiency: 2 }],
      ["minecraft:iron_axe", 4, { efficiency: 2 }],
      ["minecraft:iron_shovel", 4, { efficiency: 2 }],
      ["minecraft:iron_hoe", 1],
      ["minecraft:shears", 2],
      ["minecraft:flint_and_steel", 2],
    ],
  },
  {
    id: "utility",
    label: "Utility",
    items: [
      ["minecraft:torch", 64 * 4],
      ["minecraft:lantern", 32],
      ["minecraft:crafting_table", 4],
      ["minecraft:furnace", 4],
      ["minecraft:coal", 64 * 2],
      ["minecraft:chest", 16],
      ["minecraft:bed", 8],
      ["minecraft:ender_pearl", 16 * 2],
      ["minecraft:compass", 2],
      ["minecraft:clock", 2],
    ],
  },
  {
    id: "buckets",
    label: "Buckets",
    items: [
      ["minecraft:water_bucket", 16],
      ["minecraft:lava_bucket", 4],
      ["minecraft:bucket", 16 * 2],
      ["minecraft:milk_bucket", 3],
      ["minecraft:powder_snow_bucket", 2],
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

/** The depot's eleven columns, in CHEST_SPOTS order: [bottom kit, top kit?]. */
export const COLUMNS = [
  ["cobblestone", "dirt"],
  ["melee", "shields"],
  ["ranged", "ammo"],
  ["cobblestone", "dirt"],
  ["cobblestone", "dirt"],
  ["cobblestone", "dirt"],
  ["redstone", "traps"],
  ["food", "potions"],
  ["tools", "utility"],
  ["buckets"],
  ["enchanting"],
];
