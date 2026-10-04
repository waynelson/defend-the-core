// The Quartermaster: a vendor NPC at the depot. Talking to it opens the
// shop, where coins buy defenses and a few supplies.

import { EnchantmentType, ItemStack, system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { coreEntity, labelCore } from "./core.js";
import { addCoins, coinsOf, econ } from "./economy.js";
import { armorLevelOf, armorTier, hasUnlock, unlock, upgradeArmor } from "./loadout.js";
import { progressOf } from "./progression.js";
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
/** High-end gear: unlocked once with skill points (`sp`, shared by a set's
 * pieces through `unlock`), then bought with coins (`price`). */
export const ELITE = [
  { id: "diamond_helmet", unlock: "diamond_armor", label: "Diamond Helmet (Prot IV)", sp: 2, price: 120, give: "minecraft:diamond_helmet", enchants: PROT4 },
  { id: "diamond_chestplate", unlock: "diamond_armor", label: "Diamond Chestplate (Prot IV)", sp: 2, price: 160, give: "minecraft:diamond_chestplate", enchants: PROT4 },
  { id: "diamond_leggings", unlock: "diamond_armor", label: "Diamond Leggings (Prot IV)", sp: 2, price: 140, give: "minecraft:diamond_leggings", enchants: PROT4 },
  { id: "diamond_boots", unlock: "diamond_armor", label: "Diamond Boots (Prot IV)", sp: 2, price: 120, give: "minecraft:diamond_boots", enchants: { ...PROT4, feather_falling: 4 } },
  { id: "netherite_sword", label: "Netherite Sword (Sharpness V)", sp: 2, price: 250, give: "minecraft:netherite_sword", enchants: { sharpness: 5, unbreaking: 3, looting: 3 } },
  { id: "power_bow", label: "Bow (Power V, Infinity, Flame)", sp: 2, price: 200, give: "minecraft:bow", enchants: { power: 5, infinity: 1, flame: 1, unbreaking: 3 }, extra: ["minecraft:arrow", 1] },
  { id: "multishot_crossbow", label: "Crossbow (Multishot, Quick Charge III)", sp: 1, price: 150, give: "minecraft:crossbow", enchants: { multishot: 1, quick_charge: 3, unbreaking: 3 } },
  { id: "trident", label: "Trident (Loyalty III, Impaling V)", sp: 2, price: 250, give: "minecraft:trident", enchants: { loyalty: 3, impaling: 5, unbreaking: 3 } },
  { id: "totem", label: "Totem of Undying", sp: 2, price: 300, give: "minecraft:totem_of_undying" },
  { id: "god_apple", label: "Enchanted Golden Apple", sp: 2, price: 250, give: "minecraft:enchanted_golden_apple" },
  { id: "netherite_helmet", unlock: "netherite_armor", label: "Netherite Helmet (Prot IV)", sp: 3, price: 300, give: "minecraft:netherite_helmet", enchants: PROT4 },
  { id: "netherite_chestplate", unlock: "netherite_armor", label: "Netherite Chestplate (Prot IV)", sp: 3, price: 400, give: "minecraft:netherite_chestplate", enchants: PROT4 },
  { id: "netherite_leggings", unlock: "netherite_armor", label: "Netherite Leggings (Prot IV)", sp: 3, price: 350, give: "minecraft:netherite_leggings", enchants: PROT4 },
  { id: "netherite_boots", unlock: "netherite_armor", label: "Netherite Boots (Prot IV)", sp: 3, price: 300, give: "minecraft:netherite_boots", enchants: { ...PROT4, feather_falling: 4 } },
  { id: "mace", label: "Mace (Density V)", sp: 3, price: 400, give: "minecraft:mace", enchants: { density: 5, unbreaking: 3 } },
];
const UNLOCK_NAMES = { diamond_armor: "Diamond armour (all four pieces)", netherite_armor: "Netherite armour (all four pieces)" };
const unlockId = (entry) => entry.unlock ?? entry.id;

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

function pickElite(player, entry) {
  const id = unlockId(entry);
  if (!hasUnlock(player, id)) {
    if (!unlock(player, id, entry.sp)) {
      player.sendMessage(`§cUnlocking ${UNLOCK_NAMES[id] ?? entry.label} takes ${entry.sp} skill points.`);
      return;
    }
    player.sendMessage(`§bUnlocked ${UNLOCK_NAMES[id] ?? entry.label}!§r Buy it here with coins any time.`);
    return;
  }
  const price = econ().prices[entry.id] ?? entry.price;
  const coins = coinsOf(player);
  if (coins < price) {
    player.sendMessage(`§cYou need ${price - coins} more coins for ${entry.label}.`);
    return;
  }
  giveStack(player, enchanted(entry.give, entry.enchants));
  if (entry.extra) giveStack(player, new ItemStack(entry.extra[0], entry.extra[1]));
  const balance = addCoins(player, -price, `bought ${entry.id}`);
  emit("elite_purchase", { name: player.name, item: entry.id, price, balance });
  player.sendMessage(`§aBought ${entry.label}§r for ${price} coins. §6${balance} coins§r left.`);
}

export function openElite(player, retried = false) {
  if (!econ().shop_open) {
    player.sendMessage("§cThe Arms Dealer is closed right now.");
    return;
  }
  const prog = progressOf(player);
  const coins = coinsOf(player);
  const level = armorLevelOf(player);
  const next = armorTier(level + 1);
  const form = new ActionFormData()
    .title("§lArms Dealer")
    .body(
      `Level §6${prog.level}§r (${prog.xp}/${prog.next} XP) · §b${prog.sp} skill points§r · §6${coins} coins§r\n` +
        "Spend skill points to unlock gear, then buy it with coins."
    );
  form.button(
    next
      ? `Armour level ${level} → ${level + 1}: ${next.name}\n${prog.sp >= next.cost ? "§2" : "§4"}${next.cost} skill points`
      : `Armour level ${level}: ${armorTier(level).name}\n§8maxed out`
  );
  const config = econ();
  for (const entry of ELITE) {
    const price = config.prices[entry.id] ?? entry.price;
    const status = hasUnlock(player, unlockId(entry))
      ? `${coins >= price ? "§2" : "§4"}${price} coins`
      : `${prog.sp >= entry.sp ? "§3" : "§8"}unlock: ${entry.sp} skill points`;
    form.button(`${entry.label}\n${status}`);
  }
  form.show(player).then((response) => {
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && !retried) {
      system.runTimeout(() => openElite(player, true), 10);
      return;
    }
    if (response.canceled || response.selection === undefined) return;
    if (response.selection === 0) player.sendMessage(upgradeArmor(player).message);
    else pickElite(player, ELITE[response.selection - 1]);
    system.runTimeout(() => openElite(player), 2);
  });
}

// ---------------------------------------------------------------- vendors

const VENDORS = {
  quartermaster: "§6§lQuartermaster§r\n§7coins: turrets & supplies",
  elite: "§b§lArms Dealer§r\n§7unlock with skill points, buy with coins",
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
