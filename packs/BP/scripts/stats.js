// Player skills: ranged, melee, health, regeneration and armour, each level
// 1..5, raised with skill points at that skill's vendor, who also sells gear
// of that level for coins. Every game starts everyone afresh (200 coins,
// level 1 everything, a level-1 kit).
//
// Benefits: ranged and melee add damage to hits on attackers and guards;
// health adds max health (health boost); regeneration heals everyone over
// time; armour sets the tier of the spawn armour (loadout.js).

import { EnchantmentType, EntityDamageCause, EquipmentSlot, ItemStack, system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { addCoins, coinsOf, econ, setCoins } from "./economy.js";
import { gameNo } from "./game.js";
import { giveKit, refreshArmor } from "./loadout.js";
import { progressOf, resetProgress, spendSkillPoints } from "./progression.js";
import { emit } from "./util.js";

export const MAX_LEVEL = 5;
const RANGED_BONUS = 0.25; // extra damage per level above 1
const MELEE_BONUS = 0.25;
const REGEN_PER_SECOND = [0.25, 0.4, 0.6, 0.85, 1.2]; // by regeneration level
const ARMOR_NAMES = ["Leather", "Chainmail", "Iron", "Diamond", "Netherite"];

const POTION = { healing: 21, strong_healing: 22, regeneration: 28, long_regeneration: 29, strong_regeneration: 30 };
const PROT = (n) => ({ protection: n, unbreaking: Math.min(3, n) });

// [label, min level, price, item id, count, enchants | {potion}]
const ARMOR_ITEMS = [];
["leather", "chainmail", "iron", "diamond", "netherite"].forEach((material, i) => {
  const price = [10, 30, 60, 150, 300][i];
  const ench = i >= 3 ? PROT(i === 4 ? 4 : 2) : undefined;
  const name = ARMOR_NAMES[i];
  /** @type {[string, number][]} */
  const pieces = [["helmet", 1], ["chestplate", 1.4], ["leggings", 1.25], ["boots", 1]];
  for (const [piece, mult] of pieces) {
    ARMOR_ITEMS.push([`${name} ${piece[0].toUpperCase()}${piece.slice(1)}${ench ? ` (Prot ${ench.protection})` : ""}`, i + 1, Math.round(price * mult), `minecraft:${material}_${piece}`, 1, ench]);
  }
});

export const CATEGORIES = {
  ranged: {
    label: "Ranged", vendor: "Bowyer",
    benefit: (l) => `+${Math.round(RANGED_BONUS * (l - 1) * 100)}% arrow damage`,
    items: [
      ["Bow", 1, 40, "minecraft:bow", 1],
      ["Arrows x32", 1, 10, "minecraft:arrow", 32],
      ["Crossbow", 2, 70, "minecraft:crossbow", 1],
      ["Bow (Power I)", 2, 80, "minecraft:bow", 1, { power: 1 }],
      ["Arrows x64", 2, 18, "minecraft:arrow", 64],
      ["Bow (Power III)", 3, 150, "minecraft:bow", 1, { power: 3, unbreaking: 1 }],
      ["Crossbow (Quick Charge II)", 3, 140, "minecraft:crossbow", 1, { quick_charge: 2 }],
      ["Bow (Power V)", 4, 250, "minecraft:bow", 1, { power: 5, unbreaking: 3 }],
      ["Crossbow (Multishot)", 4, 220, "minecraft:crossbow", 1, { multishot: 1, quick_charge: 2 }],
      ["Bow (Power V, Infinity, Flame)", 5, 400, "minecraft:bow", 1, { power: 5, infinity: 1, flame: 1, unbreaking: 3 }],
      ["Crossbow (Piercing IV, Quick Charge III)", 5, 350, "minecraft:crossbow", 1, { piercing: 4, quick_charge: 3 }],
    ],
  },
  melee: {
    label: "Melee", vendor: "Blacksmith",
    benefit: (l) => `+${Math.round(MELEE_BONUS * (l - 1) * 100)}% melee damage`,
    items: [
      ["Stone Sword", 1, 15, "minecraft:stone_sword", 1],
      ["Iron Sword", 1, 50, "minecraft:iron_sword", 1],
      ["Shield", 1, 40, "minecraft:shield", 1],
      ["Iron Axe", 2, 60, "minecraft:iron_axe", 1],
      ["Iron Sword (Sharpness II)", 2, 90, "minecraft:iron_sword", 1, { sharpness: 2 }],
      ["Diamond Sword", 3, 150, "minecraft:diamond_sword", 1],
      ["Diamond Axe", 3, 160, "minecraft:diamond_axe", 1],
      ["Diamond Sword (Sharpness IV)", 4, 260, "minecraft:diamond_sword", 1, { sharpness: 4, unbreaking: 2 }],
      ["Trident (Loyalty III)", 4, 250, "minecraft:trident", 1, { loyalty: 3, unbreaking: 2 }],
      ["Netherite Sword (Sharpness V)", 5, 400, "minecraft:netherite_sword", 1, { sharpness: 5, unbreaking: 3 }],
      ["Mace (Density V)", 5, 450, "minecraft:mace", 1, { density: 5 }],
    ],
  },
  health: {
    label: "Health", vendor: "Healer",
    benefit: (l) => `+${(l - 1) * 2} hearts of max health`,
    items: [
      ["Bread x8", 1, 10, "minecraft:bread", 8],
      ["Cooked Beef x8", 1, 20, "minecraft:cooked_beef", 8],
      ["Golden Carrots x8", 2, 40, "minecraft:golden_carrot", 8],
      ["Potion of Healing", 2, 30, "minecraft:potion", 1, { potion: POTION.healing }],
      ["Golden Apple", 3, 60, "minecraft:golden_apple", 1],
      ["Splash Potion of Healing", 3, 40, "minecraft:splash_potion", 1, { potion: POTION.healing }],
      ["Potion of Healing II", 4, 50, "minecraft:potion", 1, { potion: POTION.strong_healing }],
      ["Golden Apples x3", 4, 160, "minecraft:golden_apple", 3],
      ["Enchanted Golden Apple", 5, 300, "minecraft:enchanted_golden_apple", 1],
      ["Totem of Undying", 5, 400, "minecraft:totem_of_undying", 1],
    ],
  },
  regen: {
    label: "Regeneration", vendor: "Alchemist",
    benefit: (l) => `heal ${REGEN_PER_SECOND[l - 1]} HP every second`,
    items: [
      ["Milk Bucket", 1, 15, "minecraft:milk_bucket", 1],
      ["Potion of Regeneration", 1, 40, "minecraft:potion", 1, { potion: POTION.regeneration }],
      ["Potion of Regeneration (long)", 2, 70, "minecraft:potion", 1, { potion: POTION.long_regeneration }],
      ["Splash Potion of Regeneration", 3, 80, "minecraft:splash_potion", 1, { potion: POTION.regeneration }],
      ["Potion of Regeneration II", 3, 100, "minecraft:potion", 1, { potion: POTION.strong_regeneration }],
      ["Golden Apples x2", 4, 110, "minecraft:golden_apple", 2],
      ["Splash Potion of Regeneration II", 4, 130, "minecraft:splash_potion", 1, { potion: POTION.strong_regeneration }],
      ["Enchanted Golden Apple", 5, 300, "minecraft:enchanted_golden_apple", 1],
    ],
  },
  armor: {
    label: "Armor", vendor: "Armorer",
    benefit: (l) => `respawn in ${ARMOR_NAMES[l - 1].toLowerCase()} armour`,
    items: ARMOR_ITEMS,
  },
};
export const CATEGORY_IDS = Object.keys(CATEGORIES);

// ---------------------------------------------------------------- state

function freshStats() {
  return { game: gameNo(), ...Object.fromEntries(CATEGORY_IDS.map((c) => [c, 1])) };
}

function readStats(player) {
  try {
    const raw = player.getDynamicProperty("dtc:stats");
    return typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeStats(player, stats) {
  player.setDynamicProperty("dtc:stats", JSON.stringify(stats));
}

/** Clear inventory and armour slots. */
function clearInventory(player) {
  player.getComponent("minecraft:inventory")?.container?.clearAll();
  const equippable = player.getComponent("minecraft:equippable");
  for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
    equippable?.setEquipment(slot, undefined);
  }
}

/** Start a player on this game: 200 coins (or the DM's setting), level 1
 * everything, a level-1 kit. `wipe` also clears what they carry. */
export function resetPlayer(player, wipe) {
  writeStats(player, freshStats());
  setCoins(player, econ().start_coins);
  resetProgress(player);
  player.removeEffect("health_boost");
  if (wipe) clearInventory(player);
  giveKit(player);
  emit("player_reset", { name: player.name, wiped: wipe });
}

/** The player's skills, starting them on this game if they're not yet. */
export function statsOf(player) {
  const stats = readStats(player);
  if (stats && stats.game === gameNo()) return stats;
  // Someone the add-on has never seen keeps what they carry; a player
  // from an earlier game starts this one fresh.
  resetPlayer(player, Boolean(stats));
  return readStats(player) ?? freshStats();
}

export function statOf(player, category) {
  return statsOf(player)[category] ?? 1;
}

export function setStat(player, category, level) {
  const stats = statsOf(player);
  stats[category] = Math.min(Math.max(Math.round(level), 1), MAX_LEVEL);
  writeStats(player, stats);
  if (category === "armor") refreshArmor(player);
  if (category === "health") applyHealth(player, true);
}

/** Spend skill points on the next level of a skill. */
export function train(player, category) {
  const level = statOf(player, category);
  const def = CATEGORIES[category];
  if (level >= MAX_LEVEL) return { ok: false, message: `§e${def.label} is already at the top level.` };
  const cost = level; // 1, 2, 3, 4 skill points
  if (!spendSkillPoints(player, cost)) return { ok: false, message: `§c${def.label} level ${level + 1} needs ${cost} skill points.` };
  setStat(player, category, level + 1);
  emit("skill_up", { name: player.name, skill: category, level: level + 1 });
  return { ok: true, message: `§a${def.label} level ${level + 1}:§r ${def.benefit(level + 1)}.` };
}

// ---------------------------------------------------------------- benefits

/** Health: +4 max HP per level above 1, as a long health boost. */
function applyHealth(player, force = false) {
  const level = statOf(player, "health");
  if (level <= 1) return;
  const current = player.getEffect("health_boost");
  if (!force && current && current.amplifier === level - 2 && current.duration > 400) return;
  player.addEffect("health_boost", 20 * 60 * 5, { amplifier: level - 2, showParticles: false });
}

const regenBank = new Map(); // player id -> fractional HP owed

function regenerate() {
  for (const player of world.getAllPlayers()) {
    try {
      const health = player.getComponent("minecraft:health");
      if (!health || health.currentValue <= 0) continue;
      applyHealth(player);
      if (health.currentValue >= health.effectiveMax) {
        regenBank.delete(player.id);
        continue;
      }
      const owed = (regenBank.get(player.id) ?? 0) + REGEN_PER_SECOND[statOf(player, "regen") - 1];
      const whole = Math.floor(owed);
      regenBank.set(player.id, owed - whole);
      if (whole) health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + whole));
    } catch {
      // left mid-tick
    }
  }
}

/** Ranged and melee bonuses on hits against attackers and guards. */
function bonusDamage(event) {
  const source = event.damageSource;
  const player = source.damagingEntity;
  if (player?.typeId !== "minecraft:player" || event.hurtEntity.typeId === "minecraft:player") return;
  const target = event.hurtEntity;
  if (!target.isValid || !target.matches({ families: ["dm_attacker"] }) && !target.matches({ families: ["dm_guard"] })) return;
  const ranged = source.damagingProjectile !== undefined || source.cause === EntityDamageCause.projectile;
  const level = statOf(player, ranged ? "ranged" : "melee");
  const extra = event.damage * (ranged ? RANGED_BONUS : MELEE_BONUS) * (level - 1);
  if (extra <= 0) return;
  // No damaging entity, so this hit doesn't come back here; the mark keeps
  // the bounty with the player if the bonus is what kills.
  target.setDynamicProperty("dtc:last_hit_by", player.name);
  system.run(() => {
    if (target.isValid) target.applyDamage(extra, { cause: EntityDamageCause.magic });
  });
}

// ---------------------------------------------------------------- vendors

function giveItem(player, entry) {
  const [, , , id, count, extra] = entry;
  if (extra?.potion !== undefined) {
    player.dimension.runCommand(`give "${player.name}" ${id} ${count} ${extra.potion}`);
    return;
  }
  const item = new ItemStack(id, count);
  if (extra) {
    const enchantable = item.getComponent("minecraft:enchantable");
    for (const [name, lvl] of Object.entries(extra)) {
      try {
        enchantable?.addEnchantment({ type: new EnchantmentType(name), level: lvl });
      } catch {
        // not valid on this item: skip
      }
    }
  }
  const left = player.getComponent("minecraft:inventory")?.container?.addItem(item);
  if (left) player.dimension.spawnItem(left, player.location);
}

function buy(player, category, entry) {
  const [label, minLevel, price] = entry;
  const level = statOf(player, category);
  if (level < minLevel) return player.sendMessage(`§c${label} needs ${CATEGORIES[category].label} level ${minLevel}.`);
  const coins = coinsOf(player);
  if (coins < price) return player.sendMessage(`§cYou need ${price - coins} more coins for ${label}.`);
  giveItem(player, entry);
  const balance = addCoins(player, -price, `bought ${label}`);
  emit("purchase", { name: player.name, item: label, price, balance });
  player.sendMessage(`§aBought ${label}§r for ${price} coins. §6${balance} coins§r left.`);
}

export function openSkillShop(player, category, retried = false) {
  if (!econ().shop_open) return player.sendMessage(`§cThe ${CATEGORIES[category].vendor} is closed right now.`);
  const def = CATEGORIES[category];
  const level = statOf(player, category);
  const prog = progressOf(player);
  const coins = coinsOf(player);
  const form = new ActionFormData()
    .title(`§l${def.vendor}`)
    .body(
      `${def.label} level §6${level}§r: ${def.benefit(level)}.\n` +
        `§b${prog.sp} skill points§r · §6${coins} coins§r`
    );
  form.button(
    level < MAX_LEVEL
      ? `Train ${def.label} to level ${level + 1}\n${prog.sp >= level ? "§2" : "§4"}${level} skill point${level === 1 ? "" : "s"}: ${def.benefit(level + 1)}`
      : `${def.label} level ${MAX_LEVEL}\n§8maxed out`
  );
  for (const [label, minLevel, price] of def.items) {
    form.button(`${label}\n${level < minLevel ? `§8needs level ${minLevel}` : `${coins >= price ? "§2" : "§4"}${price} coins`}`);
  }
  form.show(player).then((response) => {
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && !retried) {
      system.runTimeout(() => openSkillShop(player, category, true), 10);
      return;
    }
    if (response.canceled || response.selection === undefined) return;
    if (response.selection === 0) player.sendMessage(train(player, category).message);
    else buy(player, category, def.items[response.selection - 1]);
    system.runTimeout(() => openSkillShop(player, category), 2);
  });
}

// ---------------------------------------------------------------- events

/** A new game: everyone online starts again; others when they next appear. */
export function newGameForAll() {
  for (const player of world.getAllPlayers()) resetPlayer(player, true);
}

export function startStats() {
  system.runInterval(regenerate, 20);
  world.afterEvents.entityHurt.subscribe(bonusDamage);
  world.afterEvents.playerSpawn.subscribe((event) => {
    statsOf(event.player); // starts them on this game if needed
    applyHealth(event.player, true);
  });
}
