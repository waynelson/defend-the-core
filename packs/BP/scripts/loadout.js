// Every player's spawn kit: armour at their Armor skill level (free, locked
// to them), a stone sword, a bow and arrows. Respawns top it up without
// replacing weapons they bought.

import { EquipmentSlot, ItemLockMode, ItemStack, world } from "@minecraft/server";
import { statOf } from "./stats.js";

/** Armour tiers by Armor skill level. */
export const ARMOR_TIERS = ["leather", "chainmail", "iron", "diamond", "netherite"];
const SLOTS = [
  [EquipmentSlot.Head, "helmet"],
  [EquipmentSlot.Chest, "chestplate"],
  [EquipmentSlot.Legs, "leggings"],
  [EquipmentSlot.Feet, "boots"],
];
const KIT_ARROWS = 32;

/** Wear the Armor level's tier in every slot, locked there (it can't be
 * taken off, dropped, stored or traded) and kept on death. Anything else in
 * an armour slot goes back to the inventory. */
export function refreshArmor(player) {
  const equippable = player.getComponent("minecraft:equippable");
  if (!equippable) return;
  const material = ARMOR_TIERS[statOf(player, "armor") - 1];
  const inventory = player.getComponent("minecraft:inventory")?.container;
  for (const [slot, piece] of SLOTS) {
    const id = `minecraft:${material}_${piece}`;
    const current = equippable.getEquipment(slot);
    if (current?.typeId === id && current.lockMode === ItemLockMode.slot) {
      // Mended, so it never wears through.
      const durability = current.getComponent("minecraft:durability");
      if (durability && durability.damage > 0) {
        durability.damage = 0;
        equippable.setEquipment(slot, current);
      }
      continue;
    }
    if (current && current.lockMode !== ItemLockMode.slot) {
      const left = inventory?.addItem(current);
      if (left) player.dimension.spawnItem(left, player.location);
    }
    const stack = new ItemStack(id, 1);
    stack.lockMode = ItemLockMode.slot;
    stack.keepOnDeath = true;
    stack.nameTag = `${player.name}'s ${material} ${piece}`;
    equippable.setEquipment(slot, stack);
  }
}

function countOf(container, test) {
  let n = 0;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item && test(item.typeId)) n += item.amount;
  }
  return n;
}

/** The spawn kit, topped up: armour, a sword and a bow if they have none,
 * and arrows up to KIT_ARROWS. */
export function giveKit(player) {
  refreshArmor(player);
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory) return;
  const give = (stack) => {
    const left = inventory.addItem(stack);
    if (left) player.dimension.spawnItem(left, player.location);
  };
  const mainhand = player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)?.typeId ?? "";
  const has = (suffix) => mainhand.endsWith(suffix) || countOf(inventory, (id) => id.endsWith(suffix)) > 0;
  if (!has("_sword") && !has("_axe") && !has(":mace") && !has(":trident")) give(new ItemStack("minecraft:stone_sword", 1));
  if (!has(":bow") && !has(":crossbow")) give(new ItemStack("minecraft:bow", 1));
  const arrows = countOf(inventory, (id) => id === "minecraft:arrow");
  if (arrows < KIT_ARROWS) give(new ItemStack("minecraft:arrow", KIT_ARROWS - arrows));
}

export function startLoadout() {
  // Spawning (joining or respawning after death) tops the kit up.
  world.afterEvents.playerSpawn.subscribe((event) => giveKit(event.player));
}
