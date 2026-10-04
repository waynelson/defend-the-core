// The Pawnbroker: buys the valuable loot players bring back from towers
// and supply drops. Prices sit well below what the shops charge, and
// nothing the depot gives away (blocks, torches, coal, XP bottles) or that
// sells by the stack for pennies (food, arrows) is bought, so loot can't be
// turned into a coin machine.

import { ItemLockMode } from "@minecraft/server";
import { addCoins, coinsOf, econ } from "./economy.js";
import { menu, reopen } from "./ui.js";
import { emit } from "./util.js";

/** Item id -> [label, coins each]. */
export const BUYS = {
  "minecraft:diamond": ["Diamond", 20],
  "minecraft:iron_ingot": ["Iron Ingot", 3],
  "minecraft:golden_carrot": ["Golden Carrot", 1],
  "minecraft:golden_apple": ["Golden Apple", 15],
  "minecraft:enchanted_golden_apple": ["Enchanted Golden Apple", 100],
  "minecraft:totem_of_undying": ["Totem of Undying", 120],
  "minecraft:ender_pearl": ["Ender Pearl", 5],
  "minecraft:iron_sword": ["Iron Sword", 8],
  "minecraft:iron_pickaxe": ["Iron Pickaxe", 8],
  "minecraft:diamond_sword": ["Diamond Sword", 30],
  "minecraft:bow": ["Bow", 6],
  "minecraft:shield": ["Shield", 6],
};

/** What the player carries that the Pawnbroker buys: id -> {count, slots}. */
function sellable(player) {
  const container = player.getComponent("minecraft:inventory")?.container;
  const found = {};
  if (!container) return found;
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item || !BUYS[item.typeId] || item.lockMode !== ItemLockMode.none) continue;
    const entry = (found[item.typeId] ??= { count: 0, slots: [] });
    entry.count += item.amount;
    entry.slots.push(slot);
  }
  return found;
}

/** Sells every `ids` item the player carries; returns the coins paid. */
function sell(player, ids) {
  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) return 0;
  const found = sellable(player);
  let coins = 0;
  let items = 0;
  for (const id of ids) {
    const entry = found[id];
    if (!entry) continue;
    for (const slot of entry.slots) {
      // Check again: the inventory may have changed since the menu opened.
      const item = container.getItem(slot);
      if (!item || item.typeId !== id) continue;
      coins += item.amount * BUYS[id][1];
      items += item.amount;
      container.setItem(slot, undefined);
    }
  }
  if (coins > 0) {
    const balance = addCoins(player, coins, "sold loot");
    emit("sold", { name: player.name, items, coins, balance });
    player.sendMessage(`§aSold ${items} item${items === 1 ? "" : "s"}§r for §6${coins} coins§r. Balance: §6${balance}§r.`);
    player.playSound("random.orb");
  }
  return coins;
}

export function openPawnbroker(player) {
  if (!econ().shop_open) return player.sendMessage("§cThe Pawnbroker is closed right now.");
  const again = () => openPawnbroker(player);
  const found = sellable(player);
  const ids = Object.keys(found);
  const total = ids.reduce((n, id) => n + found[id].count * BUYS[id][1], 0);
  const prices = Object.values(BUYS)
    .map(([label, price]) => `${label} ${price}`)
    .join(", ");
  if (!ids.length) {
    menu(
      player,
      "§lPawnbroker",
      `§6${coinsOf(player)} coins§r\nYou have nothing I buy. Bring me loot from the towers and supply drops.\n\n§7I pay (each): ${prices}.`,
      [{ text: "Close", run: () => {} }]
    );
    return;
  }
  menu(
    player,
    "§lPawnbroker",
    `§6${coinsOf(player)} coins§r\nI'll buy your loot.\n\n§7I pay (each): ${prices}.`,
    [
      {
        text: `Sell everything\n§2+${total} coins`,
        run: () => {
          sell(player, ids);
          reopen(again);
        },
      },
      ...ids.map((id) => ({
        text: `${BUYS[id][0]} x${found[id].count}\n§2+${found[id].count * BUYS[id][1]} coins`,
        run: () => {
          sell(player, [id]);
          reopen(again);
        },
      })),
    ]
  );
}
