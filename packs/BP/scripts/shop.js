// The Quartermaster: a vendor NPC at the depot. Talking to it opens the
// shop, where coins buy defenses and a few supplies.

import { EnchantmentType, ItemStack, system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { coreEntity, labelCore } from "./core.js";
import { addCoins, coinsOf, econ } from "./economy.js";
import { progressOf, spendSkillPoints } from "./progression.js";
import { emit, overworld } from "./util.js";

/** Default prices; the DM can override them (economy prices). */
export const SHOP = [
  { id: "arrow_turret", label: "Arrow Turret", price: 150, give: ["dm:arrow_turret", 1], icon: "textures/items/shulker_shell" },
  { id: "flak_turret", label: "Flak Turret (flyers)", price: 200, give: ["dm:flak_turret", 1], icon: "textures/items/shulker_shell" },
  { id: "frost_turret", label: "Frost Turret", price: 120, give: ["dm:frost_turret", 1], icon: "textures/items/snowball" },
  { id: "blast_mine", label: "Blast Mine", price: 40, give: ["dm:blast_mine", 1], icon: "textures/blocks/tnt_side" },
  { id: "frost_mine", label: "Frost Mine", price: 30, give: ["dm:frost_mine", 1], icon: "textures/blocks/ice" },
  { id: "arrows", label: "Arrows x32", price: 15, give: ["minecraft:arrow", 32], icon: "textures/items/arrow" },
  { id: "golden_apple", label: "Golden Apple", price: 60, give: ["minecraft:golden_apple", 1], icon: "textures/items/apple_golden" },
  { id: "iron_blocks", label: "Iron Blocks x8", price: 80, give: ["minecraft:iron_block", 8], icon: "textures/blocks/iron_block" },
  { id: "core_repair", label: "Core Repair +25 HP", price: 100, repair: 25, icon: "textures/items/nether_star" },
];

export function priceOf(entry, config = econ()) {
  return config.prices[entry.id] ?? entry.price;
}

function give(player, typeId, amount) {
  const stack = new ItemStack(typeId, amount);
  const left = player.getComponent("minecraft:inventory")?.container?.addItem(stack);
  if (left) player.dimension.spawnItem(left, player.location); // inventory full: drop at their feet
}

function buy(player, entry) {
  const config = econ();
  const price = priceOf(entry, config);
  const coins = coinsOf(player);
  if (coins < price) {
    player.sendMessage(`§cYou need ${price - coins} more coins for ${entry.label}.`);
    return false;
  }
  if (entry.repair) {
    const core = coreEntity();
    const health = core?.getComponent("minecraft:health");
    if (!health) {
      player.sendMessage("§cThere is no core to repair.");
      return false;
    }
    if (health.currentValue >= health.effectiveMax) {
      player.sendMessage("§eThe core is already at full health.");
      return false;
    }
    health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + entry.repair));
    labelCore(core);
  } else {
    give(player, entry.give[0], entry.give[1]);
  }
  const balance = addCoins(player, -price, `bought ${entry.id}`);
  emit("purchase", { name: player.name, item: entry.id, price, balance });
  player.sendMessage(`§aBought ${entry.label}§r for ${price} coins. §6${balance} coins§r left.`);
  return true;
}

export function openShop(player, retried = false) {
  const config = econ();
  if (!config.shop_open) {
    player.sendMessage("§cThe Quartermaster's shop is closed right now.");
    return;
  }
  const coins = coinsOf(player);
  const form = new ActionFormData().title("§lQuartermaster").body(`You have §6${coins} coins§r.\nPick something to buy:`);
  for (const entry of SHOP) {
    const price = priceOf(entry, config);
    form.button(`${entry.label}\n${coins >= price ? "§2" : "§4"}${price} coins`, entry.icon);
  }
  form.show(player).then((response) => {
    // A form opened while the client is mid-interaction comes back
    // "UserBusy"; try once more a moment later.
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && !retried) {
      system.runTimeout(() => openShop(player, true), 10);
      return;
    }
    if (response.canceled || response.selection === undefined) return;
    buy(player, SHOP[response.selection]);
    // Back to the shop for the next purchase.
    system.runTimeout(() => openShop(player), 2);
  });
}

// ---------------------------------------------------------------- arms dealer

const PROT4 = { protection: 4, unbreaking: 3 };
/** High-end gear for skill points, each from a minimum level. */
export const ELITE = [
  { id: "diamond_helmet", label: "Diamond Helmet (Prot IV)", sp: 1, level: 2, give: "minecraft:diamond_helmet", enchants: PROT4 },
  { id: "diamond_chestplate", label: "Diamond Chestplate (Prot IV)", sp: 1, level: 2, give: "minecraft:diamond_chestplate", enchants: PROT4 },
  { id: "diamond_leggings", label: "Diamond Leggings (Prot IV)", sp: 1, level: 2, give: "minecraft:diamond_leggings", enchants: PROT4 },
  { id: "diamond_boots", label: "Diamond Boots (Prot IV)", sp: 1, level: 2, give: "minecraft:diamond_boots", enchants: { ...PROT4, feather_falling: 4 } },
  { id: "netherite_sword", label: "Netherite Sword (Sharpness V)", sp: 2, level: 3, give: "minecraft:netherite_sword", enchants: { sharpness: 5, unbreaking: 3, looting: 3 } },
  { id: "power_bow", label: "Bow (Power V, Infinity, Flame)", sp: 2, level: 3, give: "minecraft:bow", enchants: { power: 5, infinity: 1, flame: 1, unbreaking: 3 }, extra: ["minecraft:arrow", 1] },
  { id: "multishot_crossbow", label: "Crossbow (Multishot, Quick Charge III)", sp: 1, level: 3, give: "minecraft:crossbow", enchants: { multishot: 1, quick_charge: 3, unbreaking: 3 } },
  { id: "totem", label: "Totem of Undying", sp: 1, level: 4, give: "minecraft:totem_of_undying" },
  { id: "god_apple", label: "Enchanted Golden Apple", sp: 1, level: 4, give: "minecraft:enchanted_golden_apple" },
  { id: "trident", label: "Trident (Loyalty III, Impaling V)", sp: 2, level: 4, give: "minecraft:trident", enchants: { loyalty: 3, impaling: 5, unbreaking: 3 } },
  { id: "netherite_helmet", label: "Netherite Helmet (Prot IV)", sp: 2, level: 5, give: "minecraft:netherite_helmet", enchants: PROT4 },
  { id: "netherite_chestplate", label: "Netherite Chestplate (Prot IV)", sp: 2, level: 5, give: "minecraft:netherite_chestplate", enchants: PROT4 },
  { id: "netherite_leggings", label: "Netherite Leggings (Prot IV)", sp: 2, level: 5, give: "minecraft:netherite_leggings", enchants: PROT4 },
  { id: "netherite_boots", label: "Netherite Boots (Prot IV)", sp: 2, level: 5, give: "minecraft:netherite_boots", enchants: { ...PROT4, feather_falling: 4 } },
  { id: "mace", label: "Mace (Density V)", sp: 3, level: 6, give: "minecraft:mace", enchants: { density: 5, unbreaking: 3 } },
];

function enchanted(typeId, enchants = {}) {
  const item = new ItemStack(typeId, 1);
  const enchantable = item.getComponent("minecraft:enchantable");
  for (const [name, level] of Object.entries(enchants)) {
    try {
      enchantable?.addEnchantment({ type: new EnchantmentType(name), level });
    } catch {
      // not valid on this item, or unknown: skip it
    }
  }
  return item;
}

function giveStack(player, stack) {
  const left = player.getComponent("minecraft:inventory")?.container?.addItem(stack);
  if (left) player.dimension.spawnItem(left, player.location);
}

function buyElite(player, entry) {
  const prog = progressOf(player);
  if (prog.level < entry.level) {
    player.sendMessage(`§c${entry.label} needs level ${entry.level}; you are level ${prog.level}.`);
    return;
  }
  if (!spendSkillPoints(player, entry.sp)) {
    player.sendMessage(`§cYou need ${entry.sp} skill point${entry.sp === 1 ? "" : "s"} for ${entry.label}.`);
    return;
  }
  giveStack(player, enchanted(entry.give, entry.enchants));
  if (entry.extra) giveStack(player, new ItemStack(entry.extra[0], entry.extra[1]));
  emit("elite_purchase", { name: player.name, item: entry.id, sp: entry.sp });
  player.sendMessage(`§aGot ${entry.label}§r for ${entry.sp} skill point${entry.sp === 1 ? "" : "s"}.`);
}

export function openElite(player, retried = false) {
  if (!econ().shop_open) {
    player.sendMessage("§cThe Arms Dealer is closed right now.");
    return;
  }
  const prog = progressOf(player);
  const form = new ActionFormData()
    .title("§lArms Dealer")
    .body(`Level §6${prog.level}§r (${prog.xp}/${prog.next} XP) · §b${prog.sp} skill points§r\nLevel up by surviving rounds and killing attackers.`);
  for (const entry of ELITE) {
    const ready = prog.level >= entry.level && prog.sp >= entry.sp;
    const lock = prog.level < entry.level ? `§8level ${entry.level}` : `${ready ? "§2" : "§4"}${entry.sp} SP`;
    form.button(`${entry.label}\n${lock}`);
  }
  form.show(player).then((response) => {
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && !retried) {
      system.runTimeout(() => openElite(player, true), 10);
      return;
    }
    if (response.canceled || response.selection === undefined) return;
    buyElite(player, ELITE[response.selection]);
    system.runTimeout(() => openElite(player), 2);
  });
}

// ---------------------------------------------------------------- vendors

const VENDORS = {
  quartermaster: "§6§lQuartermaster§r\n§7coins: turrets & supplies",
  elite: "§b§lArms Dealer§r\n§7skill points: elite gear",
};

/** Puts a vendor at `location` (one of each kind per world). */
export function spawnVendor(location, kind = "quartermaster") {
  for (const old of overworld().getEntities({ type: "dm:vendor" })) {
    const oldKind = old.getDynamicProperty("dtc:shop") ?? "quartermaster";
    if (oldKind === kind) old.remove();
  }
  const vendor = overworld().spawnEntity("dm:vendor", location);
  vendor.setDynamicProperty("dtc:shop", kind);
  vendor.nameTag = VENDORS[kind];
  return vendor;
}

export function startShop() {
  world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    if (event.target.typeId !== "dm:vendor") return;
    if (event.target.getDynamicProperty("dtc:shop") === "elite") openElite(event.player);
    else openShop(event.player);
  });
}
