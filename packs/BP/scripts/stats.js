// Player skills: ranged, melee, health, regeneration, armour and
// engineering, each level 1..5, raised with skill points at that skill's
// vendor, who also sells gear of that level for coins. Every game starts
// everyone afresh (starting coins and skill points, level 1 everything, a
// level-1 kit).
//
// Benefits: ranged and melee add damage to hits on attackers and guards;
// health adds max health (health boost); regeneration heals everyone over
// time; armour sets the tier of the free armour locked to each player
// (loadout.js), which the Armorer enchants for coins; engineering raises
// turret and mine limits and turret durability (defenses.js).

import { EntityDamageCause, EquipmentSlot, system, world } from "@minecraft/server";
import { econ, setCoins } from "./economy.js";
import { gameNo, hudLines } from "./game.js";
import { giveKit, refreshArmor } from "./loadout.js";
import { progressOf, resetProgress, spendSkillPoints } from "./progression.js";
import { charge, menu, priceText, reopen, ROMAN, sell } from "./ui.js";
import { emit } from "./util.js";

export const MAX_LEVEL = 5;
const RANGED_BONUS = 0.25; // extra damage per level above 1
const MELEE_BONUS = 0.25;
const REGEN_PER_SECOND = [0.25, 0.4, 0.6, 0.85, 1.2]; // by regeneration level
const ARMOR_NAMES = ["Leather", "Chainmail", "Iron", "Diamond", "Netherite"];
export const TURRETS_PER_LEVEL = 1;
export const MINES_PER_LEVEL = 3;
export const DURABILITY_PER_LEVEL = 0.1;

const POTION = {
  healing: 21, strong_healing: 22,
  regeneration: 28, long_regeneration: 29, strong_regeneration: 30,
  swiftness: 14, long_fire_resistance: 13,
  long_strength: 32, strong_strength: 33, slow_falling: 40, turtle_master: 37,
};

// Items: [label, min level, price, item id, count, enchants | {potion}]
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
  // The Healer heals now; the Alchemist heals over time and sells buffs.
  health: {
    label: "Health", vendor: "Healer",
    benefit: (l) => `+${(l - 1) * 2} hearts of max health`,
    items: [
      ["Golden Carrots x8", 1, 30, "minecraft:golden_carrot", 8],
      ["Potion of Healing", 1, 30, "minecraft:potion", 1, { potion: POTION.healing }],
      ["Golden Apple", 2, 60, "minecraft:golden_apple", 1],
      ["Splash Potion of Healing", 2, 40, "minecraft:splash_potion", 1, { potion: POTION.healing }],
      ["Potion of Healing II", 3, 50, "minecraft:potion", 1, { potion: POTION.strong_healing }],
      ["Splash Potion of Healing II", 4, 65, "minecraft:splash_potion", 1, { potion: POTION.strong_healing }],
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
      ["Potion of Swiftness", 1, 30, "minecraft:potion", 1, { potion: POTION.swiftness }],
      ["Potion of Regeneration (long)", 2, 70, "minecraft:potion", 1, { potion: POTION.long_regeneration }],
      ["Potion of Fire Resistance", 2, 40, "minecraft:potion", 1, { potion: POTION.long_fire_resistance }],
      ["Potion of Slow Falling", 2, 30, "minecraft:potion", 1, { potion: POTION.slow_falling }],
      ["Potion of Strength", 3, 70, "minecraft:potion", 1, { potion: POTION.long_strength }],
      ["Splash Potion of Regeneration", 3, 80, "minecraft:splash_potion", 1, { potion: POTION.regeneration }],
      ["Potion of Regeneration II", 3, 100, "minecraft:potion", 1, { potion: POTION.strong_regeneration }],
      ["Potion of Strength II", 4, 120, "minecraft:potion", 1, { potion: POTION.strong_strength }],
      ["Splash Potion of Regeneration II", 4, 130, "minecraft:splash_potion", 1, { potion: POTION.strong_regeneration }],
      ["Potion of the Turtle Master", 5, 150, "minecraft:potion", 1, { potion: POTION.turtle_master }],
    ],
  },
  armor: {
    label: "Armor", vendor: "Armorer",
    benefit: (l) => `wear ${ARMOR_NAMES[l - 1].toLowerCase()} armour (free, locked to you)`,
    items: [], // armour comes with the level; the Armorer sells enchantments
  },
  engineer: {
    label: "Engineering", vendor: "Engineer",
    benefit: (l) =>
      `+${(l - 1) * TURRETS_PER_LEVEL} turrets, +${(l - 1) * MINES_PER_LEVEL} mines, ` +
      `+${Math.round((l - 1) * DURABILITY_PER_LEVEL * 100)}% turret durability`,
    items: [], // the Engineer's stock is in shop.js
  },
};
export const CATEGORY_IDS = Object.keys(CATEGORIES);

// ---------------------------------------------------------------- state

function freshStats() {
  return { game: gameNo(), ...Object.fromEntries(CATEGORY_IDS.map((c) => [c, 1])), armor_ench: {} };
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

/** Called with (player, category) when a skill changes ("reset" for a new
 * game). */
export const statHooks = [];

/** Start a player on this game: starting coins, level 1 everything, a
 * level-1 kit. `wipe` also clears what they carry. */
export function resetPlayer(player, wipe) {
  writeStats(player, freshStats());
  for (const old of ["dtc:armor_level", "dtc:unlocks"]) player.setDynamicProperty(old, undefined);
  setCoins(player, econ().start_coins);
  resetProgress(player);
  player.removeEffect("health_boost");
  if (wipe) clearInventory(player);
  giveKit(player);
  statHooks.forEach((fn) => fn(player, "reset"));
  emit("player_reset", { name: player.name, wiped: wipe });
}

/** The player's skills, starting them on this game if they're not yet. */
export function statsOf(player) {
  const stats = readStats(player);
  if (stats && stats.game === gameNo()) return { engineer: 1, armor_ench: {}, ...stats };
  // Someone the add-on has never seen keeps what they carry; a player
  // from an earlier game (or from before skills existed) starts this one
  // fresh.
  resetPlayer(player, Boolean(stats) || playedBefore(player));
  return readStats(player) ?? freshStats();
}

/** Whether a player without skills has played an older version: a coin
 * balance, levels, or the old armour and unlock properties. */
function playedBefore(player) {
  for (const id of ["coins", "dm_level"]) {
    try {
      if (world.scoreboard.getObjective(id)?.hasParticipant(player)) return true;
    } catch {
      // no such objective
    }
  }
  return ["dtc:armor_level", "dtc:unlocks"].some((key) => player.getDynamicProperty(key) !== undefined);
}

export function statOf(player, category) {
  return statsOf(player)[category] ?? 1;
}

export function setStat(player, category, level) {
  const stats = statsOf(player);
  stats[category] = Math.min(Math.max(Math.round(level), 1), MAX_LEVEL);
  writeStats(player, stats);
  if (category === "armor") refreshArmor(player, true);
  if (category === "health") applyHealth(player, true);
  statHooks.forEach((fn) => fn(player, category));
}

/** The Armorer's work on a player's armour. */
export function armorEnchantsOf(player) {
  return { style: "protection", protection: 0, thorns: 0, feather_falling: 0, ...statsOf(player).armor_ench };
}

function setArmorEnchants(player, ench) {
  const stats = statsOf(player);
  stats.armor_ench = ench;
  writeStats(player, stats);
  refreshArmor(player, true);
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

/** The train button every skill vendor starts with. */
export function trainButton(player, category, again) {
  const def = CATEGORIES[category];
  const level = statOf(player, category);
  const sp = progressOf(player).sp;
  return {
    text:
      level < MAX_LEVEL
        ? `Train ${def.label} to level ${level + 1}\n${sp >= level ? "§2" : "§4"}${level} skill point${level === 1 ? "" : "s"}: ${def.benefit(level + 1)}`
        : `${def.label} level ${MAX_LEVEL}\n§8maxed out`,
    run: () => {
      player.sendMessage(train(player, category).message);
      reopen(again);
    },
  };
}

/** The top of a skill vendor's menu: the skill's level and points. */
export function skillBody(player, category) {
  const def = CATEGORIES[category];
  const level = statOf(player, category);
  return `${def.label} level §6${level}§r: ${def.benefit(level)}.\n§b${progressOf(player).sp} skill points§r`;
}

export function openSkillShop(player, category) {
  const def = CATEGORIES[category];
  if (!econ().shop_open) return player.sendMessage(`§cThe ${def.vendor} is closed right now.`);
  if (category === "armor") return openArmorer(player);
  const level = statOf(player, category);
  const again = () => openSkillShop(player, category);
  const buttons = [trainButton(player, category, again)];
  for (const [label, minLevel, price, id, count, extra] of def.items) {
    buttons.push({
      text: `${label}\n${level < minLevel ? `§8needs level ${minLevel}` : priceText(player, price)}`,
      run: () => {
        if (statOf(player, category) < minLevel) player.sendMessage(`§c${label} needs ${def.label} level ${minLevel}.`);
        else sell(player, [label, id, count, price, extra]);
        reopen(again);
      },
    });
  }
  menu(player, `§l${def.vendor}`, skillBody(player, category), buttons);
}

// The Armorer: enchantments on the locked armour, gated by Armor level.
export const STYLES = {
  protection: "Protection",
  blast_protection: "Blast Protection",
  projectile_protection: "Projectile Protection",
};
/** @type {[string, string | null, number, number[], number[]][]} */
const UPGRADES = [
  // [key, label (null: the protection style), max, price of each next
  // level, Armor level each next level needs]
  ["protection", null, 4, [60, 120, 200, 320], [1, 2, 3, 4]],
  ["thorns", "Thorns", 3, [80, 160, 260], [2, 3, 4]],
  ["feather_falling", "Feather Falling", 4, [30, 60, 90, 120], [1, 1, 2, 3]],
];
const STYLE_SWITCH_PRICE = 50;

function openArmorer(player) {
  const again = () => openArmorer(player);
  const level = statOf(player, "armor");
  const ench = armorEnchantsOf(player);
  const buttons = [trainButton(player, "armor", again)];
  for (const [key, fixedLabel, max, prices, needs] of UPGRADES) {
    const label = fixedLabel ?? STYLES[ench.style];
    const have = ench[key];
    if (have >= max) {
      buttons.push({ text: `${label} ${ROMAN[have]}\n§8maxed out`, run: () => reopen(again) });
      continue;
    }
    const price = prices[have];
    const need = needs[have];
    const name = `${label} ${ROMAN[have + 1]}`;
    buttons.push({
      text: `${name}\n${level < need ? `§8needs Armor level ${need}` : priceText(player, price)}`,
      run: () => {
        if (statOf(player, "armor") < need) player.sendMessage(`§c${name} needs Armor level ${need}.`);
        else if (charge(player, price, `${name} on your armour`)) {
          setArmorEnchants(player, { ...ench, [key]: have + 1 });
          emit("armor_enchanted", { name: player.name, enchant: key === "protection" ? ench.style : key, level: have + 1 });
        }
        reopen(again);
      },
    });
  }
  for (const [style, label] of Object.entries(STYLES)) {
    if (style === ench.style) continue;
    buttons.push({
      text: `Switch to ${label}\n${priceText(player, STYLE_SWITCH_PRICE)} §8(keeps the level)`,
      run: () => {
        if (charge(player, STYLE_SWITCH_PRICE, `${label} on your armour`)) setArmorEnchants(player, { ...ench, style });
        reopen(again);
      },
    });
  }
  const current = [
    ench.protection ? `${STYLES[ench.style]} ${ROMAN[ench.protection]}` : "",
    ench.thorns ? `Thorns ${ROMAN[ench.thorns]}` : "",
    ench.feather_falling ? `Feather Falling ${ROMAN[ench.feather_falling]}` : "",
  ].filter(Boolean);
  menu(
    player,
    "§lArmorer",
    `${skillBody(player, "armor")}\nYour armour: ${current.join(", ") || "no enchantments"}.\n§7One kind of protection at a time.`,
    buttons
  );
}

// ---------------------------------------------------------------- HUD

const HUD_NAMES = { ranged: "Ranged", melee: "Melee", health: "Health", regen: "Regen", armor: "Armor", engineer: "Eng" };

/** The player's own action-bar lines: level, XP and skill points to spend,
 * then their level in each skill (gold when maxed). */
function hudText(player) {
  const prog = progressOf(player);
  const stats = statsOf(player);
  const sp = prog.sp > 0 ? `§b§l${prog.sp} skill point${prog.sp === 1 ? "" : "s"} to spend§r` : "§70 skill points";
  const skills = CATEGORY_IDS.map((c) => {
    const level = stats[c] ?? 1;
    return `§7${HUD_NAMES[c]} ${level >= MAX_LEVEL ? "§6" : "§f"}${level}`;
  }).join("  ");
  return `§6Level ${prog.level}§7 · ${prog.xp}/${prog.next} XP · ${sp}\n${skills}`;
}

// ---------------------------------------------------------------- events

/** A new game: everyone online starts again; others when they next appear. */
export function newGameForAll() {
  for (const player of world.getAllPlayers()) resetPlayer(player, true);
}

export function startStats() {
  hudLines.push(hudText);
  system.runInterval(regenerate, 20);
  world.afterEvents.entityHurt.subscribe(bonusDamage);
  world.afterEvents.playerSpawn.subscribe((event) => {
    statsOf(event.player); // starts them on this game if needed
    applyHealth(event.player, true);
  });
}
