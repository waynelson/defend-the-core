// Player defenses: turrets and mines placed from shop items.
//
// Using a defense item on a block places it on the face clicked. Turrets
// are dm:turret_* entities owned by the placing player (per-player limit);
// mines are pressure plates whose positions are kept in a world property,
// armed a few seconds after placing and set off when an attacker comes
// near. Kills by a player's turrets or mines pay that player's bounty.

import { system, world } from "@minecraft/server";
import { econ } from "./economy.js";
import { emit, overworld, store, stored } from "./util.js";

const MINES_PROP = "dtc:mines"; // [{x, y, z, type, owner, armed_tick}]
const ARM_TICKS = 60;
const TRIGGER_RADIUS = 1.8;

const TURRET_ITEMS = {
  "dm:arrow_turret": { entity: "dm:turret_arrow", label: "Arrow Turret" },
  "dm:flak_turret": { entity: "dm:turret_flak", label: "Flak Turret" },
  "dm:frost_turret": { entity: "dm:turret_frost", label: "Frost Turret" },
};
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
  const limit = econ().turret_limit;
  if (turretsOf(player.name).length >= limit) return player.sendMessage(`§cYou already have ${limit} turrets. Lose one to place another.`);
  if (!useOneHeld(player, spec.item)) return;
  const turret = dim.spawnEntity(spec.entity, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
  turret.setDynamicProperty("dtc:owner", player.name);
  turret.nameTag = `${spec.label}\n§7${player.name}`;
  emit("turret_placed", { name: player.name, turret: spec.entity, at: spot });
  player.sendMessage(`§a${spec.label} placed§r (${turretsOf(player.name).length}/${limit}).`);
}

function placeMine(player, spec, spot) {
  const dim = player.dimension;
  const at = dim.getBlock(spot);
  const below = at?.below();
  if (!at?.isAir || !below || below.isAir || below.isLiquid) return player.sendMessage("§cA mine needs solid ground.");
  const list = mines();
  const limit = econ().mine_limit;
  if (list.filter((m) => m.owner === player.name).length >= limit) return player.sendMessage(`§cYou already have ${limit} mines out.`);
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
    hp: Math.ceil(t.getComponent("minecraft:health")?.currentValue ?? 0),
  }));
  return { turrets, mines: mines().map(({ x, y, z, type, owner }) => ({ at: { x, y, z }, type, owner })) };
}

/** DM: place a defense for a player (or nobody) at a spot. */
export function dmPlace(msg) {
  const item = Object.keys(TURRET_ITEMS).find((k) => TURRET_ITEMS[k].entity === `dm:turret_${msg.type}`);
  if (!item) throw new Error("type must be arrow, flak or frost");
  const turret = overworld().spawnEntity(TURRET_ITEMS[item].entity, { x: msg.x + 0.5, y: msg.y, z: msg.z + 0.5 });
  turret.setDynamicProperty("dtc:owner", msg.owner ?? "");
  turret.nameTag = TURRET_ITEMS[item].label;
  return { placed: turret.typeId };
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

export function startDefenses() {
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
