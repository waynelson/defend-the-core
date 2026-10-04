// Player defenses: turrets and mines placed from shop items.
//
// Using a defense item on a block places it on the face clicked. Turrets
// are dm:turret_* entities owned by the placing player (per-player limit,
// raised by Engineering). Their health is kept by this script: base x tier x
// the owner's Engineering durability, shown as a bar on the name tag.
// Talking to a turret repairs it (coins per HP), upgrades its tier (faster,
// longer reach, tougher; tiers need Engineering levels) or picks it up;
// mines are pressure plates whose positions are kept in a world property,
// armed a few seconds after placing and set off when an attacker comes
// near. Kills by a player's turrets or mines pay that player's bounty.

import { ItemStack, system, world } from "@minecraft/server";
import { coinsOf, econ } from "./economy.js";
import { priceOf, SHOP } from "./shop.js";
import { DURABILITY_PER_LEVEL, MINES_PER_LEVEL, statHooks, statOf, TURRETS_PER_LEVEL } from "./stats.js";
import { charge, menu, reopen, ROMAN } from "./ui.js";
import { emit, overworld, store, stored } from "./util.js";

const MINES_PROP = "dtc:mines"; // [{x, y, z, type, owner, armed_tick}]
const ARM_TICKS = 60;
const TRIGGER_RADIUS = 1.8;

const TURRET_ITEMS = {
  "dm:arrow_turret": { entity: "dm:turret_arrow", label: "Arrow Turret", hp: 40, shop: "arrow_turret", range: 16 },
  "dm:flak_turret": { entity: "dm:turret_flak", label: "Flak Turret", hp: 40, shop: "flak_turret", range: 32 },
  "dm:frost_turret": { entity: "dm:turret_frost", label: "Frost Turret", hp: 30, shop: "frost_turret", range: 14 },
};
const TURRET_TYPES = Object.values(TURRET_ITEMS).map((t) => t.entity);
const TIER_HP = [1, 1.5, 2];
const TIER_RANGE = [1, 1.25, 1.5]; // matches tools/gen_entities.py TIERS
const TIER_NEEDS = [1, 2, 4]; // Engineering level to upgrade to each tier
const UPGRADE_COST = [0, 1, 1.5]; // x the turret's price, to reach each tier
const MINE_ITEMS = {
  "dm:blast_mine": { type: "blast", block: "minecraft:polished_blackstone_pressure_plate", label: "Blast Mine" },
  "dm:frost_mine": { type: "frost", block: "minecraft:light_weighted_pressure_plate", label: "Frost Mine" },
};
const MINE_BLOCKS = new Set(Object.values(MINE_ITEMS).map((m) => m.block));

const FACE = {
  Up: { x: 0, y: 1, z: 0 }, Down: { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 }, South: { x: 0, y: 0, z: 1 },
  West: { x: -1, y: 0, z: 0 }, East: { x: 1, y: 0, z: 0 },
};

// ---------------------------------------------------------------- helpers

function useOneHeld(player, typeId) {
  const inventory = player.getComponent("minecraft:inventory")?.container;
  const slot = player.selectedSlotIndex;
  const stack = inventory?.getItem(slot);
  if (!stack || stack.typeId !== typeId) return false;
  if (stack.amount > 1) {
    stack.amount -= 1;
    inventory.setItem(slot, stack);
  } else {
    inventory.setItem(slot, undefined);
  }
  return true;
}

function specOf(turret) {
  return Object.entries(TURRET_ITEMS).find(([, s]) => s.entity === turret.typeId) ?? [];
}

function turretLimit(player) {
  return econ().turret_limit + (statOf(player, "engineer") - 1) * TURRETS_PER_LEVEL;
}

function mineLimit(player) {
  return econ().mine_limit + (statOf(player, "engineer") - 1) * MINES_PER_LEVEL;
}

const num = (turret, prop, fallback) => {
  const v = turret.getDynamicProperty(prop);
  return typeof v === "number" ? v : fallback;
};

/** {hp, max, tier} of a turret. */
export function turretState(turret) {
  const [, spec] = specOf(turret);
  const tier = num(turret, "dtc:tier", 1);
  const eng = num(turret, "dtc:eng", 1);
  const max = Math.round((spec?.hp ?? 40) * TIER_HP[tier - 1] * (1 + DURABILITY_PER_LEVEL * (eng - 1)));
  const hp = Math.ceil(turret.getComponent("minecraft:health")?.currentValue ?? 0);
  return { hp: Math.min(hp, max), max, tier };
}

function labelTurret(turret) {
  const [, spec] = specOf(turret);
  if (!spec || !turret.isValid) return;
  const { hp, max, tier } = turretState(turret);
  const owner = turret.getDynamicProperty("dtc:owner");
  const filled = Math.max(0, Math.min(10, Math.round((hp / max) * 10)));
  const colour = hp / max > 0.5 ? "§a" : hp / max > 0.25 ? "§e" : "§c";
  turret.nameTag = `${spec.label} ${ROMAN[tier]}${owner ? `\n§7${owner}` : ""}\n${colour}${"|".repeat(filled)}§8${"|".repeat(10 - filled)} §f${hp}/${max}`;
}

/** Sets tier and Engineering level, keeping the damage taken (or, `full`,
 * healing it). */
function setTurret(turret, { tier = undefined, eng = undefined, full = false }) {
  const before = turretState(turret);
  if (tier !== undefined) {
    turret.setDynamicProperty("dtc:tier", tier);
    turret.triggerEvent(`dtc:tier_${tier}`);
  }
  if (eng !== undefined) turret.setDynamicProperty("dtc:eng", eng);
  const after = turretState(turret);
  const damage = full ? 0 : Math.max(0, before.max - before.hp);
  turret.getComponent("minecraft:health")?.setCurrentValue(Math.max(1, after.max - damage));
  labelTurret(turret);
}

/** Turrets from before tiers and script-kept health: tier 1, health as is. */
function adopt(turret) {
  if (!turret.isValid || !TURRET_TYPES.includes(turret.typeId) || turret.getDynamicProperty("dtc:tier") !== undefined) return;
  turret.setDynamicProperty("dtc:tier", 1);
  turret.setDynamicProperty("dtc:eng", 1);
  turret.triggerEvent("dtc:tier_1");
  labelTurret(turret);
}

function turretsOf(name) {
  return overworld().getEntities({ families: ["dm_turret"] }).filter((t) => t.getDynamicProperty("dtc:owner") === name);
}

function mines() {
  return stored(MINES_PROP, []);
}

function saveMines(list) {
  store(MINES_PROP, list);
}

const sameSpot = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Credit the next bounty for these mobs to `owner` (mines and turret slows). */
function markHits(entities, owner) {
  for (const mob of entities) {
    try {
      mob.setDynamicProperty("dtc:last_hit_by", owner);
    } catch {
      // gone already
    }
  }
}

// ---------------------------------------------------------------- placing

function placeTurret(player, spec, spot) {
  const dim = player.dimension;
  const at = dim.getBlock(spot);
  const above = at?.above();
  if (!at?.isAir || !above?.isAir) return player.sendMessage("§cA turret needs two blocks of clear space.");
  const limit = turretLimit(player);
  if (turretsOf(player.name).length >= limit) return player.sendMessage(`§cYou already have ${limit} turrets (train Engineering for more).`);
  if (!useOneHeld(player, spec.item)) return;
  const turret = dim.spawnEntity(spec.entity, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
  turret.setDynamicProperty("dtc:owner", player.name);
  setTurret(turret, { tier: 1, eng: statOf(player, "engineer"), full: true });
  emit("turret_placed", { name: player.name, turret: spec.entity, at: spot });
  player.sendMessage(`§a${spec.label} placed§r (${turretsOf(player.name).length}/${limit}).`);
}

function placeMine(player, spec, spot) {
  const dim = player.dimension;
  const at = dim.getBlock(spot);
  const below = at?.below();
  if (!at?.isAir || !below || below.isAir || below.isLiquid) return player.sendMessage("§cA mine needs solid ground.");
  const list = mines();
  const limit = mineLimit(player);
  if (list.filter((m) => m.owner === player.name).length >= limit) return player.sendMessage(`§cYou already have ${limit} mines out (train Engineering for more).`);
  if (!useOneHeld(player, spec.item)) return;
  at.setType(spec.block);
  list.push({ ...spot, type: spec.type, owner: player.name, armed_tick: system.currentTick + ARM_TICKS });
  saveMines(list);
  emit("mine_placed", { name: player.name, mine: spec.type, at: spot });
  player.sendMessage(`§a${spec.label} placed§r: it arms in ${ARM_TICKS / 20} seconds.`);
}

// ---------------------------------------------------------------- mines

function triggerMine(mine, mobs) {
  const dim = overworld();
  const center = { x: mine.x + 0.5, y: mine.y + 0.2, z: mine.z + 0.5 };
  dim.getBlock(mine)?.setType("minecraft:air");
  const near = dim.getEntities({ location: center, maxDistance: 5, families: ["dm_attacker"] });
  markHits(near, mine.owner);
  if (mine.type === "blast") {
    // Hurts what's nearby without breaking anyone's walls.
    dim.createExplosion(center, 3, { breaksBlocks: false, causesFire: false });
  } else {
    for (const mob of near) mob.addEffect("slowness", 200, { amplifier: 3 });
    for (const mob of mobs.slice(0, 4)) {
      const feet = dim.getBlock({ x: Math.floor(mob.location.x), y: Math.floor(mob.location.y), z: Math.floor(mob.location.z) });
      if (feet?.isAir) feet.setType("minecraft:web");
    }
    try {
      dim.spawnParticle("minecraft:snowflake_particle", center);
    } catch {
      // cosmetic
    }
  }
  emit("mine_triggered", { mine: mine.type, owner: mine.owner, at: { x: mine.x, y: mine.y, z: mine.z }, hit: near.length });
}

function checkMines() {
  const list = mines();
  if (!list.length) return;
  const dim = overworld();
  const now = system.currentTick;
  const keep = [];
  let changed = false;
  for (const mine of list) {
    let block;
    try {
      block = dim.getBlock(mine);
    } catch {
      keep.push(mine); // unloaded: check later
      continue;
    }
    if (!block || !MINE_BLOCKS.has(block.typeId)) {
      changed = true; // broken or blown away
      continue;
    }
    if (now < mine.armed_tick) {
      keep.push(mine);
      continue;
    }
    const mobs = dim.getEntities({
      location: { x: mine.x + 0.5, y: mine.y, z: mine.z + 0.5 },
      maxDistance: TRIGGER_RADIUS,
      families: ["dm_attacker"],
    });
    if (mobs.length) {
      triggerMine(mine, mobs);
      changed = true;
    } else {
      keep.push(mine);
    }
  }
  if (changed) saveMines(keep);
}

// ---------------------------------------------------------------- events

/** The player to pay for an attacker's death, or undefined. */
export function bountyOwner(dead, damagingEntity) {
  if (damagingEntity?.typeId === "minecraft:player") return damagingEntity.name;
  const owner = damagingEntity?.getDynamicProperty?.("dtc:owner");
  if (typeof owner === "string") return owner;
  try {
    const marked = dead.getDynamicProperty("dtc:last_hit_by");
    return typeof marked === "string" ? marked : undefined;
  } catch {
    return undefined;
  }
}

/** For the DM tab: everyone's turrets and mines. */
export function defenseList() {
  const turrets = overworld().getEntities({ families: ["dm_turret"] }).map((t) => ({
    type: t.typeId.replace("dm:turret_", ""),
    owner: t.getDynamicProperty("dtc:owner"),
    at: { x: Math.floor(t.location.x), y: Math.floor(t.location.y), z: Math.floor(t.location.z) },
    ...turretState(t),
  }));
  return { turrets, mines: mines().map(({ x, y, z, type, owner }) => ({ at: { x, y, z }, type, owner })) };
}

/** DM: place a defense for a player (or nobody) at a spot. */
export function dmPlace(msg) {
  const item = Object.keys(TURRET_ITEMS).find((k) => TURRET_ITEMS[k].entity === `dm:turret_${msg.type}`);
  if (!item) throw new Error("type must be arrow, flak or frost");
  const turret = overworld().spawnEntity(TURRET_ITEMS[item].entity, { x: msg.x + 0.5, y: msg.y, z: msg.z + 0.5 });
  turret.setDynamicProperty("dtc:owner", msg.owner ?? "");
  setTurret(turret, { tier: msg.tier ?? 1, eng: 1, full: true });
  return { placed: turret.typeId, tier: msg.tier ?? 1 };
}

/** DM: lay a mine ({type: blast|frost, x, y, z, owner?}); armed at once. */
export function dmMine(msg) {
  const spec = Object.values(MINE_ITEMS).find((m) => m.type === msg.type);
  if (!spec) throw new Error("type must be blast or frost");
  const spot = { x: msg.x, y: msg.y, z: msg.z };
  const block = overworld().getBlock(spot);
  if (!block?.isAir) throw new Error("that spot isn't empty");
  block.setType(spec.block);
  saveMines([...mines(), { ...spot, type: spec.type, owner: msg.owner ?? "", armed_tick: 0 }]);
  return { placed: spec.type, at: spot };
}

// ---------------------------------------------------------------- turret menu

function repairButton(player, turret, owner) {
  const { hp, max } = turretState(turret);
  const rate = econ().repair_rate;
  const price = Math.ceil((max - hp) * rate);
  return {
    text: `Repair +${max - hp} HP\n${coinsOf(player) >= price ? "§2" : "§4"}${price} coins`,
    run: () => {
      if (!turret.isValid) return;
      const now = turretState(turret);
      // As much as they can afford.
      const heal = Math.min(now.max - now.hp, rate > 0 ? Math.floor(coinsOf(player) / rate) : now.max);
      if (heal <= 0) return player.sendMessage(`§cYou need ${Math.ceil(rate)} coins to repair anything.`);
      if (!charge(player, Math.ceil(heal * rate), `${heal} HP of turret repairs`)) return;
      turret.getComponent("minecraft:health")?.setCurrentValue(now.hp + heal);
      labelTurret(turret);
      emit("turret_repaired", { name: player.name, owner, turret: turret.typeId, hp: heal });
      reopen(() => openTurret(player, turret));
    },
  };
}

function upgradeButton(player, turret, spec, owner) {
  const next = turretState(turret).tier + 1;
  const need = TIER_NEEDS[next - 1];
  const base = SHOP.find((s) => s.id === spec.shop);
  const price = Math.round((base ? priceOf(base) : 150) * UPGRADE_COST[next - 1]);
  const level = statOf(player, "engineer");
  const cost = level < need ? `§8needs Engineering ${need}` : `${coinsOf(player) >= price ? "§2" : "§4"}${price} coins`;
  return {
    text: `Upgrade to tier ${ROMAN[next]}\n${cost}§8: faster, ${Math.round(spec.range * TIER_RANGE[next - 1])} range`,
    run: () => {
      if (!turret.isValid) return;
      if (statOf(player, "engineer") < need) return player.sendMessage(`§cTier ${ROMAN[next]} needs Engineering level ${need}.`);
      if (!charge(player, price, `${spec.label} tier ${ROMAN[next]}`)) return;
      setTurret(turret, { tier: next }); // the extra health comes with it
      emit("turret_upgraded", { name: player.name, owner, turret: turret.typeId, tier: next });
      reopen(() => openTurret(player, turret));
    },
  };
}

function pickUpButton(player, turret, item, spec) {
  return {
    text: `Pick up\n§8back to your inventory${turretState(turret).tier > 1 ? " (upgrades are lost)" : ""}`,
    run: () => {
      if (!turret.isValid) return;
      const now = turretState(turret);
      if (now.hp < now.max) return player.sendMessage("§cRepair it before picking it up.");
      turret.remove();
      const left = player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(item, 1));
      if (left) player.dimension.spawnItem(left, player.location);
      emit("turret_picked_up", { name: player.name, turret: spec.entity });
    },
  };
}

function openTurret(player, turret) {
  if (!turret.isValid) return;
  const [item, spec] = specOf(turret);
  if (!spec) return;
  adopt(turret);
  const { hp, max, tier } = turretState(turret);
  const owner = turret.getDynamicProperty("dtc:owner");
  const buttons = [];
  if (hp < max) buttons.push(repairButton(player, turret, owner));
  if (tier < 3) buttons.push(upgradeButton(player, turret, spec, owner));
  if (owner === player.name) buttons.push(pickUpButton(player, turret, item, spec));
  buttons.push({ text: "Close", run: () => {} });
  menu(
    player,
    `§l${spec.label} ${ROMAN[tier]}`,
    `Owner: ${owner || "the DM"}\nHealth: ${hp}/${max}\nRange: ${Math.round(spec.range * TIER_RANGE[tier - 1])} blocks\n§6${coinsOf(player)} coins§r`,
    buttons
  );
}

export function startDefenses() {
  world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    if (TURRET_TYPES.includes(event.target.typeId)) openTurret(event.player, event.target);
  });
  world.afterEvents.entityHurt.subscribe((event) => labelTurret(event.hurtEntity), { entityTypes: TURRET_TYPES });
  world.afterEvents.entityLoad.subscribe((event) => adopt(event.entity));
  system.runTimeout(() => {
    for (const t of overworld().getEntities({ families: ["dm_turret"] })) adopt(t);
  }, 40);
  // Engineering raises the durability of the turrets a player already has.
  statHooks.push((player, category) => {
    if (category !== "engineer" && category !== "reset") return;
    const eng = statOf(player, "engineer");
    for (const t of turretsOf(player.name)) setTurret(t, { eng });
  });

  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const held = event.beforeItemStack?.typeId;
    if (!held || !event.isFirstEvent) return;
    const offset = FACE[event.blockFace] ?? FACE.Up;
    const spot = { x: event.block.x + offset.x, y: event.block.y + offset.y, z: event.block.z + offset.z };
    if (TURRET_ITEMS[held]) placeTurret(event.player, { ...TURRET_ITEMS[held], item: held }, spot);
    else if (MINE_ITEMS[held]) placeMine(event.player, { ...MINE_ITEMS[held], item: held }, spot);
  });

  // Frost turret snowballs slow what they hit.
  world.afterEvents.projectileHitEntity.subscribe((event) => {
    if (event.source?.typeId !== "dm:turret_frost") return;
    const hit = event.getEntityHit()?.entity;
    if (!hit?.isValid || !hit.matches({ families: ["dm_attacker"] })) return;
    hit.addEffect("slowness", 60, { amplifier: 1 });
    markHits([hit], event.source.getDynamicProperty("dtc:owner"));
  });

  // Turret arrows never hurt players.
  world.beforeEvents.entityHurt.subscribe((event) => {
    if (event.hurtEntity.typeId !== "minecraft:player") return;
    const source = event.damageSource.damagingEntity;
    if (source && source.typeId.startsWith("dm:turret_")) event.cancel = true;
  });

  world.afterEvents.entityDie.subscribe(
    (event) => {
      const t = event.deadEntity;
      emit("turret_destroyed", {
        turret: t.typeId,
        owner: t.getDynamicProperty("dtc:owner"),
        by: event.damageSource.damagingEntity?.typeId ?? event.damageSource.cause,
      });
    },
    { entityTypes: ["dm:turret_arrow", "dm:turret_flak", "dm:turret_frost"] }
  );

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const list = mines();
    const left = list.filter((m) => !sameSpot(m, event.block.location));
    if (left.length !== list.length) saveMines(left);
  });

  system.runInterval(checkMines, 5);
}
