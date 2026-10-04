// Vendors: who stands where and what talking to each opens. The Engineer
// trains Engineering and sells turrets, mines, traps and core repairs; the
// Provisioner sells tools, food and odds and ends; the Mason (mason.js)
// sells blocks; the skill vendors (stats.js) train their skill and sell its
// gear.

import { world } from "@minecraft/server";
import { coreEntity, labelCore } from "./core.js";
import { coinsOf, econ } from "./economy.js";
import { openMason } from "./mason.js";
import { openPawnbroker } from "./pawn.js";
import { CATEGORIES, openSkillShop, skillBody, trainButton } from "./stats.js";
import { charge, giveItem, menu, priceText, reopen, sell } from "./ui.js";
import { overworld } from "./util.js";

/** The Engineer's defenses; the DM can override these prices. */
export const SHOP = [
  { id: "arrow_turret", label: "Arrow Turret", price: 150, give: ["dm:arrow_turret", 1], icon: "textures/items/shulker_shell" },
  { id: "flak_turret", label: "Flak Turret (flyers)", price: 200, give: ["dm:flak_turret", 1], icon: "textures/items/shulker_shell" },
  { id: "frost_turret", label: "Frost Turret", price: 120, give: ["dm:frost_turret", 1], icon: "textures/items/snowball" },
  { id: "blast_mine", label: "Blast Mine", price: 40, give: ["dm:blast_mine", 1], icon: "textures/blocks/tnt_side" },
  { id: "frost_mine", label: "Frost Mine", price: 30, give: ["dm:frost_mine", 1], icon: "textures/blocks/ice" },
  { id: "core_repair", label: "Core Repair +25 HP", price: 100, repair: 25, icon: "textures/items/nether_star" },
];

// [label, id, count, price]
const TRAPS = [
  ["TNT x4", "minecraft:tnt", 4, 60],
  ["Flint and Steel", "minecraft:flint_and_steel", 1, 10],
  ["Dispenser x4", "minecraft:dispenser", 4, 30],
  ["Piston x4", "minecraft:piston", 4, 20],
  ["Sticky Piston x4", "minecraft:sticky_piston", 4, 35],
  ["Observer x4", "minecraft:observer", 4, 30],
  ["Redstone x64", "minecraft:redstone", 64, 20],
  ["Redstone Torch x16", "minecraft:redstone_torch", 16, 10],
  ["Repeater x8", "minecraft:repeater", 8, 15],
  ["Lever x8", "minecraft:lever", 8, 5],
  ["Stone Pressure Plate x8", "minecraft:stone_pressure_plate", 8, 10],
  ["Tripwire Hook x4 + String x16", "minecraft:tripwire_hook", 4, 15],
  ["Target x4", "minecraft:target", 4, 20],
  ["Magma x16", "minecraft:magma", 16, 30],
  ["Soul Sand x16", "minecraft:soul_sand", 16, 15],
  ["Honey Block x8", "minecraft:honey_block", 8, 30],
  ["Cactus x8", "minecraft:cactus", 8, 15],
  ["Pointed Dripstone x8", "minecraft:pointed_dripstone", 8, 20],
  ["Campfire x4", "minecraft:campfire", 4, 20],
];

// The Provisioner: no skill, just coins. [label, id, count, price]
const PROVISIONS = {
  Tools: [
    ["Stone Pickaxe", "minecraft:stone_pickaxe", 1, 8],
    ["Iron Pickaxe", "minecraft:iron_pickaxe", 1, 40],
    ["Diamond Pickaxe", "minecraft:diamond_pickaxe", 1, 120],
    ["Stone Axe", "minecraft:stone_axe", 1, 8],
    ["Iron Axe", "minecraft:iron_axe", 1, 40],
    ["Iron Shovel", "minecraft:iron_shovel", 1, 25],
    ["Shears", "minecraft:shears", 1, 10],
    ["Spyglass", "minecraft:spyglass", 1, 20],
  ],
  Food: [
    ["Bread x16", "minecraft:bread", 16, 15],
    ["Baked Potatoes x16", "minecraft:baked_potato", 16, 15],
    ["Cooked Beef x16", "minecraft:cooked_beef", 16, 30],
    ["Cooked Chicken x16", "minecraft:cooked_chicken", 16, 20],
    ["Pumpkin Pie x8", "minecraft:pumpkin_pie", 8, 20],
  ],
  "Light & Storage": [
    ["Lanterns x16", "minecraft:lantern", 16, 20],
    ["Glowstone x16", "minecraft:glowstone", 16, 30],
    ["Chests x4", "minecraft:chest", 4, 10],
    ["Barrels x4", "minecraft:barrel", 4, 10],
    ["Bed", "minecraft:bed", 1, 20],
  ],
  Utility: [
    ["Bucket", "minecraft:bucket", 1, 15],
    ["Water Bucket", "minecraft:water_bucket", 1, 20],
    ["Lava Bucket", "minecraft:lava_bucket", 1, 40],
    ["Ender Pearls x4", "minecraft:ender_pearl", 4, 60],
    ["Name Tag", "minecraft:name_tag", 1, 15],
  ],
};

export function priceOf(entry, config = econ()) {
  return config.prices[entry.id] ?? entry.price;
}

function closed(player, who) {
  if (econ().shop_open) return false;
  player.sendMessage(`§cThe ${who} is closed right now.`);
  return true;
}

// ---------------------------------------------------------------- engineer

function buyDefense(player, entry) {
  const price = priceOf(entry);
  if (entry.repair) {
    const core = coreEntity();
    const health = core?.getComponent("minecraft:health");
    if (!health) return player.sendMessage("§cThere is no core to repair.");
    if (health.currentValue >= health.effectiveMax) return player.sendMessage("§eThe core is already at full health.");
    if (!charge(player, price, entry.label)) return;
    health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + entry.repair));
    labelCore(core);
    return;
  }
  if (charge(player, price, entry.label)) giveItem(player, entry.give[0], entry.give[1]);
}

function openTraps(player) {
  const again = () => openTraps(player);
  menu(player, "§lTraps & Redstone", `§6${coinsOf(player)} coins§r`, [
    { text: "« Back", run: () => reopen(() => openEngineer(player)) },
    ...TRAPS.map((entry) => ({
      text: `${entry[0]}\n${priceText(player, entry[3])}`,
      run: () => {
        if (sell(player, entry) && entry[1] === "minecraft:tripwire_hook") giveItem(player, "minecraft:string", 16);
        reopen(again);
      },
    })),
  ]);
}

export function openEngineer(player) {
  if (closed(player, "Engineer")) return;
  const again = () => openEngineer(player);
  const config = econ();
  menu(player, "§lEngineer", `${skillBody(player, "engineer")} · §6${coinsOf(player)} coins§r\n§7Talk to a placed turret to repair or upgrade it.`, [
    trainButton(player, "engineer", again),
    ...SHOP.map((entry) => ({
      text: `${entry.label}\n${priceText(player, priceOf(entry, config))}`,
      icon: entry.icon,
      run: () => {
        buyDefense(player, entry);
        reopen(again);
      },
    })),
    { text: "Traps & Redstone\n§8TNT, pistons, magma, cactus…", icon: "textures/blocks/redstone_block", run: () => reopen(() => openTraps(player)) },
  ]);
}

// ---------------------------------------------------------------- provisioner

function openProvisions(player, section) {
  const again = () => openProvisions(player, section);
  menu(player, `§l${section}`, `§6${coinsOf(player)} coins§r`, [
    { text: "« Back", run: () => reopen(() => openProvisioner(player)) },
    ...PROVISIONS[section].map((entry) => ({
      text: `${entry[0]}\n${priceText(player, entry[3])}`,
      run: () => {
        sell(player, entry);
        reopen(again);
      },
    })),
  ]);
}

export function openProvisioner(player) {
  if (closed(player, "Provisioner")) return;
  menu(
    player,
    "§lProvisioner",
    `§6${coinsOf(player)} coins§r\nTools, food and supplies. Dirt, cobblestone and torches are free at the depot.`,
    Object.keys(PROVISIONS).map((section) => ({
      text: `${section}\n§8${PROVISIONS[section].length} items`,
      run: () => reopen(() => openProvisions(player, section)),
    }))
  );
}

// ---------------------------------------------------------------- vendors

export const VENDORS = {
  engineer: "§6§lEngineer§r\n§7turrets, traps & repairs",
  mason: "§6§lMason§r\n§7free dirt & cobble, blocks for coins",
  provisioner: "§6§lProvisioner§r\n§7tools, food & supplies",
  pawnbroker: "§6§lPawnbroker§r\n§7buys tower loot for coins",
  ...Object.fromEntries(
    Object.entries(CATEGORIES)
      .filter(([id]) => id !== "engineer")
      .map(([id, c]) => [id, `§b§l${c.vendor}§r\n§7${c.label}: ${c.items.length ? "train & buy" : "train & upgrade"}`])
  ),
};

/** Puts a vendor at `location` (one of each kind; older ones and kinds that
 * no longer exist are removed). */
export function spawnVendor(location, kind) {
  for (const old of overworld().getEntities({ type: "dm:vendor" })) {
    const oldKind = String(old.getDynamicProperty("dtc:shop") ?? "quartermaster");
    if (oldKind === kind || !VENDORS[oldKind]) old.remove();
  }
  const vendor = overworld().spawnEntity("dm:vendor", location);
  vendor.setDynamicProperty("dtc:shop", kind);
  vendor.nameTag = VENDORS[kind];
  return vendor;
}

export function startShop() {
  world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    if (event.target.typeId !== "dm:vendor") return;
    const kind = String(event.target.getDynamicProperty("dtc:shop") ?? "engineer");
    if (kind === "mason") openMason(event.player);
    else if (kind === "provisioner") openProvisioner(event.player);
    else if (kind === "pawnbroker") openPawnbroker(event.player);
    else if (kind !== "engineer" && CATEGORIES[kind]) openSkillShop(event.player, kind);
    else openEngineer(event.player);
  });
}
