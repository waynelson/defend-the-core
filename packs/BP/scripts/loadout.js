// Every player's spawn kit: armour at their Armor skill level, a stone
// sword, a bow and arrows. Respawns top it up without replacing better
// armour or weapons they bought.

import { EquipmentSlot, ItemStack, world } from "@minecraft/server";
import { statOf } from "./stats.js";

/** Armour tiers by Armor skill level. */
export const ARMOR_TIERS = ["leather", "chainmail", "iron", "diamond", "netherite"];
const RANK = { leather: 1, golden: 1.5, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const SLOTS = [
  [EquipmentSlot.Head, "helmet"],
  [EquipmentSlot.Chest, "chestplate"],
  [EquipmentSlot.Legs, "leggings"],
  [EquipmentSlot.Feet, "boots"],
];
const KIT_ARROWS = 32;

function rankOf(stack) {
  if (!stack) return 0;
  return RANK[stack.typeId.replace("minecraft:", "").split("_")[0]] ?? 0;
}

/** Wear the tier's armour in every slot that is empty or holds something
 * weaker (better armour they bought stays on). */
export function refreshArmor(player) {
  const equippable = player.getComponent("minecraft:equippable");
  if (!equippable) return;
  const material = ARMOR_TIERS[statOf(player, "armor") - 1];
  for (const [slot, piece] of SLOTS) {
    if (rankOf(equippable.getEquipment(slot)) >= RANK[material]) continue;
    equippable.setEquipment(slot, new ItemStack(`minecraft:${material}_${piece}`, 1));
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
