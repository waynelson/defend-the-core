// Shared vendor UI: action-form menus and selling items for coins.

import { EnchantmentType, ItemStack, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { addCoins, coinsOf } from "./economy.js";
import { emit } from "./util.js";

/**
 * A menu of buttons, each {text, icon?, run}. A form opened while the client
 * is mid-interaction comes back "UserBusy"; that retries once.
 */
export function menu(player, title, body, buttons, retried = false) {
  const form = new ActionFormData().title(title).body(body);
  for (const b of buttons) form.button(b.text, b.icon);
  form.show(player).then((response) => {
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && !retried) {
      system.runTimeout(() => menu(player, title, body, buttons, true), 10);
      return;
    }
    if (response.canceled || response.selection === undefined) return;
    buttons[response.selection]?.run();
  });
}

/** Run `open` again shortly, for menus that stay open between purchases. */
export function reopen(open) {
  system.runTimeout(open, 2);
}

/** Price text for a button: green if affordable, red if not. */
export function priceText(player, price) {
  if (price === 0) return "§2free";
  return `${coinsOf(player) >= price ? "§2" : "§4"}${price} coins`;
}

/** Puts an item in a player's inventory (or at their feet if it's full).
 * extra: {enchant: level, ...} or {potion: data value}. */
export function giveItem(player, id, count, extra) {
  if (extra?.potion !== undefined) {
    // No stable API for potion types.
    for (let n = 0; n < count; n++) player.runCommand(`give @s ${id} 1 ${extra.potion}`);
    return;
  }
  const item = new ItemStack(id, 1);
  const stacks = [];
  for (let left = count; left > 0; ) {
    const stack = item.clone();
    stack.amount = Math.min(left, stack.maxAmount);
    left -= stack.amount;
    if (extra) {
      const enchantable = stack.getComponent("minecraft:enchantable");
      for (const [name, level] of Object.entries(extra)) {
        try {
          enchantable?.addEnchantment({ type: new EnchantmentType(name), level });
        } catch {
          // not valid on this item: skip
        }
      }
    }
    stacks.push(stack);
  }
  const inventory = player.getComponent("minecraft:inventory")?.container;
  for (const stack of stacks) {
    const left = inventory?.addItem(stack);
    if (left) player.dimension.spawnItem(left, player.location);
  }
}

/** Takes the coins for something, or explains why not. True if paid. */
export function charge(player, price, label) {
  const coins = coinsOf(player);
  if (coins < price) {
    player.sendMessage(`§cYou need ${price - coins} more coins for ${label}.`);
    return false;
  }
  if (price > 0) {
    const balance = addCoins(player, -price, `bought ${label}`);
    emit("purchase", { name: player.name, item: label, price, balance });
    player.sendMessage(`§aBought ${label}§r for ${price} coins. §6${balance} coins§r left.`);
  }
  return true;
}

/** Sells [label, id, count, price, extra?].
 * @param {any} player
 * @param {any[]} entry */
export function sell(player, entry) {
  const [label, id, count, price, extra] = entry;
  if (!charge(player, price, label)) return false;
  giveItem(player, id, count, extra);
  return true;
}

export const ROMAN = ["", "I", "II", "III", "IV", "V"];
