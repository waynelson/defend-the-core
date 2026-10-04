// Every player's loadout: a spawn kit (a full set of armour at their armour
// level, a sword, a bow and arrows), the armour level they raise with skill
// points, and the Arms Dealer items they have unlocked with skill points.
// Armour level and unlocks are player dynamic properties, so they persist.

import { EquipmentSlot, ItemStack, world } from "@minecraft/server";
import { spendSkillPoints } from "./progression.js";
import { emit } from "./util.js";

/** Armour tiers by level; cost = skill points to reach that level. */
export const ARMOR_TIERS = [
  { level: 1, name: "Leather", material: "leather", cost: 0 },
  { level: 2, name: "Chainmail", material: "chainmail", cost: 1 },
  { level: 3, name: "Iron", material: "iron", cost: 2 },
  { level: 4, name: "Diamond", material: "diamond", cost: 3 },
  { level: 5, name: "Netherite", material: "netherite", cost: 4 },
];
const RANK = { leather: 1, golden: 1.5, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const SLOTS = [
  [EquipmentSlot.Head, "helmet"],
  [EquipmentSlot.Chest, "chestplate"],
  [EquipmentSlot.Legs, "leggings"],
  [EquipmentSlot.Feet, "boots"],
];
const KIT_ARROWS = 32;

export function armorLevelOf(player) {
  const level = player.getDynamicProperty("dtc:armor_level");
  return typeof level === "number" ? Math.min(Math.max(level, 1), ARMOR_TIERS.length) : 1;
}

export function armorTier(level) {
  return ARMOR_TIERS[level - 1];
}

export function unlocksOf(player) {
  const raw = player.getDynamicProperty("dtc:unlocks");
  try {
    return typeof raw === "string" ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function hasUnlock(player, id) {
  return unlocksOf(player).includes(id);
}

/** Spend skill points to unlock an Arms Dealer item for good. */
export function unlock(player, id, cost) {
  if (hasUnlock(player, id)) return true;
  if (!spendSkillPoints(player, cost)) return false;
  player.setDynamicProperty("dtc:unlocks", JSON.stringify([...unlocksOf(player), id]));
  emit("unlock", { name: player.name, item: id, sp: cost });
  return true;
}

function rankOf(stack) {
  if (!stack) return 0;
  const material = stack.typeId.replace("minecraft:", "").split("_")[0];
  return RANK[material] ?? 0;
}

/** Wear the armour of the player's tier in every slot that is empty or
 * holds something weaker (better armour they bought stays on). */
function equipArmor(player) {
  const equippable = player.getComponent("minecraft:equippable");
  if (!equippable) return;
  const tier = armorTier(armorLevelOf(player));
  for (const [slot, piece] of SLOTS) {
    if (rankOf(equippable.getEquipment(slot)) >= RANK[tier.material]) continue;
    equippable.setEquipment(slot, new ItemStack(`minecraft:${tier.material}_${piece}`, 1));
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
  equipArmor(player);
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory) return;
  const give = (stack) => {
    const left = inventory.addItem(stack);
    if (left) player.dimension.spawnItem(left, player.location);
  };
  const mainhand = player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)?.typeId ?? "";
  const has = (suffix) => mainhand.endsWith(suffix) || countOf(inventory, (id) => id.endsWith(suffix)) > 0;
  if (!has("_sword")) give(new ItemStack("minecraft:iron_sword", 1));
  if (!has(":bow") && !has(":crossbow")) give(new ItemStack("minecraft:bow", 1));
  const arrows = countOf(inventory, (id) => id === "minecraft:arrow");
  if (arrows < KIT_ARROWS) give(new ItemStack("minecraft:arrow", KIT_ARROWS - arrows));
}

/** Spend skill points on the next armour level; wears the new tier at once. */
export function upgradeArmor(player) {
  const level = armorLevelOf(player);
  const next = armorTier(level + 1);
  if (!next) return { ok: false, message: "§eYour armour is already the best there is." };
  if (!spendSkillPoints(player, next.cost)) {
    return { ok: false, message: `§cArmour level ${next.level} (${next.name}) needs ${next.cost} skill points.` };
  }
  player.setDynamicProperty("dtc:armor_level", next.level);
  equipArmor(player);
  emit("armor_level", { name: player.name, level: next.level, tier: next.name });
  return { ok: true, message: `§aArmour level ${next.level}: ${next.name}.§r You'll spawn in it from now on.` };
}

/** DM: set a player's armour level directly. */
export function setArmorLevel(player, level) {
  player.setDynamicProperty("dtc:armor_level", Math.min(Math.max(Math.round(level), 1), ARMOR_TIERS.length));
  equipArmor(player);
}

export function startLoadout() {
  // Spawning (first join or respawn after death) tops the kit up.
  world.afterEvents.playerSpawn.subscribe((event) => giveKit(event.player));
}
