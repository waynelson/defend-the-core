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

/** @returns {[string, number, Record<string, number>][]} */
const IRON_SET = (n, enchants = { protection: 1 }) => [
  ["minecraft:iron_helmet", n, enchants],
  ["minecraft:iron_chestplate", n, enchants],
  ["minecraft:iron_leggings", n, enchants],
  ["minecraft:iron_boots", n, enchants],
];

/** @type {{id: string, label: string, items: [string, number, Record<string, number>?][]}[]} */
export const KITS = [
  // ---- armour: 9 sets
  {
    id: "armor_1",
    label: "Armor I",
    items: [
      ["minecraft:diamond_helmet", 1, { protection: 2 }],
      ["minecraft:diamond_chestplate", 1, { protection: 2 }],
      ["minecraft:diamond_leggings", 1, { protection: 2 }],
      ["minecraft:diamond_boots", 1, { protection: 2, feather_falling: 2 }],
      ...IRON_SET(4, { protection: 2 }),
    ],
  },
  { id: "armor_2", label: "Armor II", items: IRON_SET(4) },

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

  // ---- building: ~100 stacks of everything
  {
    id: "building_1",
    label: "Stone",
    items: [
      ["minecraft:cobblestone", 64 * 6],
      ["minecraft:stone", 64 * 3],
      ["minecraft:stone_bricks", 64 * 6],
      ["minecraft:smooth_stone", 64 * 2],
      ["minecraft:andesite", 64 * 2],
      ["minecraft:polished_andesite", 64 * 2],
      ["minecraft:brick_block", 64 * 3],
      ["minecraft:sandstone", 64 * 2],
      ["minecraft:mossy_cobblestone", 64],
    ],
  },
  {
    id: "building_2",
    label: "Wood",
    items: [
      ["minecraft:oak_planks", 64 * 5],
      ["minecraft:spruce_planks", 64 * 4],
      ["minecraft:birch_planks", 64 * 3],
      ["minecraft:oak_log", 64 * 3],
      ["minecraft:spruce_log", 64 * 3],
      ["minecraft:oak_fence", 64 * 2],
      ["minecraft:fence_gate", 32],
      ["minecraft:wooden_door", 16],
      ["minecraft:trapdoor", 32],
      ["minecraft:ladder", 64 * 2],
      ["minecraft:oak_stairs", 64],
    ],
  },
  {
    id: "building_3",
    label: "Shapes",
    items: [
      ["minecraft:stone_brick_slab", 64 * 3],
      ["minecraft:stone_brick_stairs", 64 * 3],
      ["minecraft:cobblestone_slab", 64 * 2],
      ["minecraft:stone_stairs", 64 * 2],
      ["minecraft:cobblestone_wall", 64 * 3],
      ["minecraft:stone_brick_wall", 64 * 3],
      ["minecraft:oak_slab", 64 * 2],
      ["minecraft:smooth_stone_slab", 64 * 2],
      ["minecraft:brick_stairs", 64],
      ["minecraft:brick_slab", 64],
      ["minecraft:sandstone_stairs", 64],
    ],
  },
  {
    id: "building_4",
    label: "Earth & Glass",
    items: [
      ["minecraft:dirt", 64 * 5],
      ["minecraft:sand", 64 * 3],
      ["minecraft:gravel", 64 * 3],
      ["minecraft:glass", 64 * 4],
      ["minecraft:glass_pane", 64 * 3],
      ["minecraft:scaffolding", 64 * 3],
      ["minecraft:white_wool", 64 * 2],
      ["minecraft:clay", 64 * 2],
    ],
  },

  // ---- defenses
  {
    id: "fortify",
    label: "Fortify",
    items: [
      ["minecraft:iron_block", 64],
      ["minecraft:deepslate_bricks", 64 * 6],
      ["minecraft:polished_blackstone_bricks", 64 * 5],
      ["minecraft:deepslate_tiles", 64 * 4],
      ["minecraft:iron_bars", 64 * 3],
      ["minecraft:iron_trapdoor", 32],
      ["minecraft:iron_door", 8],
      ["minecraft:web", 64],
    ],
  },
  {
    id: "fortify_2",
    label: "Walls",
    items: [
      ["minecraft:deepslate_brick_wall", 64 * 4],
      ["minecraft:deepslate_brick_stairs", 64 * 3],
      ["minecraft:deepslate_brick_slab", 64 * 3],
      ["minecraft:polished_blackstone_brick_wall", 64 * 3],
      ["minecraft:end_bricks", 64 * 4],
      ["minecraft:nether_brick", 64 * 4],
      ["minecraft:nether_brick_fence", 64 * 2],
    ],
  },
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
  ["armor_1", "armor_2"],
  ["melee", "shields"],
  ["ranged", "ammo"],
  ["building_1", "building_2"],
  ["building_3", "building_4"],
  ["fortify", "fortify_2"],
  ["redstone", "traps"],
  ["food", "potions"],
  ["tools", "utility"],
  ["buckets"],
  ["enchanting"],
];
