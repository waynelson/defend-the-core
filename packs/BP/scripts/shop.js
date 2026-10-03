// The Quartermaster: a vendor NPC at the depot. Talking to it opens the
// shop, where coins buy defenses and a few supplies.

import { ItemStack, system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { coreEntity, labelCore } from "./core.js";
import { addCoins, coinsOf, econ } from "./economy.js";
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

/** Puts the Quartermaster at `location` (one vendor per world). */
export function spawnVendor(location) {
  for (const old of overworld().getEntities({ type: "dm:vendor" })) old.remove();
  const vendor = overworld().spawnEntity("dm:vendor", location);
  vendor.nameTag = "§6§lQuartermaster§r\n§7talk to trade";
  return vendor;
}

export function startShop() {
  world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    if (event.target.typeId === "dm:vendor") openShop(event.player);
  });
}
