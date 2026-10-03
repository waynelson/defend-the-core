// Breaching: one block damage map that every breach source writes to, stuck
// detection, and the breach modules (dig, detonate_stuck, siege_arrow).
//
// Damage is measured in "seconds of digging at dps 1". A block breaks when its
// damage reaches hardnessSeconds(block) x breach_mult, and damage decays so
// players can out-repair weak attackers.

import { system, world } from "@minecraft/server";
import { coreCenter, coreLocation, isCoreBlock } from "./core.js";
import { attackers, mobModules } from "./spawner.js";
import { blockKey, emit, overworld, pos, store, stored } from "./util.js";

const CONFIG_PROP = "dtc:config";
const DEFAULT_CONFIG = {
  breach_mult: 1.0, // scales every block's threshold
  decay_rate: 0.25, // damage removed per second from every damaged block
  max_attackers: 60, // attackers tracked for stuck detection
  hardness: {}, // block id -> seconds, overrides the table below
};

// Seconds of dps-1 digging per block. Roughly vanilla hardness x 3, so
// cobblestone takes a lone digger (dps 1.5) about 4 s and obsidian ~100 s.
const HARDNESS = {
  "minecraft:dirt": 1.5,
  "minecraft:grass_block": 1.8,
  "minecraft:sand": 1.5,
  "minecraft:gravel": 1.8,
  "minecraft:stone": 4.5,
  "minecraft:cobblestone": 6,
  "minecraft:mossy_cobblestone": 6,
  "minecraft:stone_bricks": 4.5,
  "minecraft:bricks": 6,
  "minecraft:web": 4,
  "minecraft:end_stone": 9,
  "minecraft:netherite_block": 150,
  "minecraft:ancient_debris": 90,
};
const HARDNESS_KEYWORDS = [
  ["obsidian", 150], ["deepslate", 10.5], ["iron", 15], ["copper", 9], ["glass", 1],
  ["leaves", 0.6], ["wool", 2.4], ["planks", 6], ["_log", 6], ["wood", 6], ["fence", 6],
  ["door", 9], ["concrete", 5.4], ["terracotta", 3.8], ["sandstone", 2.4], ["bricks", 4.5],
  ["slab", 4.5], ["stairs", 4.5], ["wall", 4.5],
];
const DEFAULT_HARDNESS = 4.5;

const PROTECTED = new Set([
  "minecraft:bedrock", "minecraft:barrier", "minecraft:command_block",
  "minecraft:repeating_command_block", "minecraft:chain_command_block",
  "minecraft:structure_block", "minecraft:end_portal_frame",
]);
// Mobs walk through these, so they are never what blocks a path.
const PASSABLE_KEYWORDS = [
  "short_grass", "tall_grass", "fern", "deadbush", "flower", "sapling", "torch", "sign", "carpet",
  "vine", "rail", "button", "lever", "pressure_plate", "redstone_wire", "tripwire", "snow_layer",
  "tulip", "poppy", "dandelion", "daisy", "orchid", "allium", "bluet", "lily", "mushroom",
];

const SAMPLE_TICKS = 10; // stuck detection and dig cadence
const SAMPLE_SECONDS = SAMPLE_TICKS / 20;
const WINDOW = 5; // samples per stuck window (2.5 s)
const STUCK_MOVED = 0.6; // max blocks moved over the window
const STUCK_CLOSING = 0.4; // max blocks closer to the core over the window
const REACH = 2.2; // closer than this to the core is attacking, not stuck

/** "x,y,z" -> {damage, type} */
const damageMap = new Map();
/** entity id -> {history: [{x, z, dist}], stuckSince, detonated} */
const tracking = new Map();

// ---------------------------------------------------------------- config

export function getConfig() {
  return { ...DEFAULT_CONFIG, ...stored(CONFIG_PROP, {}) };
}

export function setConfig(changes) {
  const config = getConfig();
  if (changes.breach_mult !== undefined) config.breach_mult = clamp("breach_mult", changes.breach_mult, 0.05, 20);
  if (changes.decay_rate !== undefined) config.decay_rate = clamp("decay_rate", changes.decay_rate, 0, 10);
  if (changes.max_attackers !== undefined) config.max_attackers = clamp("max_attackers", changes.max_attackers, 1, 200);
  if (changes.hardness !== undefined) {
    for (const [id, seconds] of Object.entries(changes.hardness)) {
      if (seconds === null) delete config.hardness[id];
      else config.hardness[id] = clamp(`hardness.${id}`, seconds, 0.1, 1000);
    }
  }
  store(CONFIG_PROP, config);
  return config;
}

function clamp(name, value, min, max) {
  if (typeof value !== "number" || value < min || value > max) {
    throw new Error(`${name} must be a number in ${min}..${max}`);
  }
  return value;
}

// ---------------------------------------------------------------- blocks

export function hardnessSeconds(typeId, config = getConfig()) {
  if (config.hardness[typeId] !== undefined) return config.hardness[typeId];
  if (HARDNESS[typeId] !== undefined) return HARDNESS[typeId];
  const rule = HARDNESS_KEYWORDS.find(([word]) => typeId.includes(word));
  return rule ? rule[1] : DEFAULT_HARDNESS;
}

export function isProtected(block) {
  return PROTECTED.has(block.typeId) || isCoreBlock(block);
}

function isBreachable(block) {
  if (!block || block.isAir || block.isLiquid || isProtected(block)) return false;
  return !PASSABLE_KEYWORDS.some((word) => block.typeId.includes(word));
}

/** Adds breach damage to a block; breaks it (no drops) at its threshold.
 * Returns true if the block took damage. */
export function addDamage(block, amount, source) {
  if (!isBreachable(block)) return false;
  const config = getConfig();
  const key = blockKey(block.location);
  let entry = damageMap.get(key);
  if (!entry || entry.type !== block.typeId) entry = { damage: 0, type: block.typeId };
  entry.damage += amount;
  const threshold = hardnessSeconds(block.typeId, config) * config.breach_mult;
  const dim = block.dimension;
  const center = block.center();
  if (entry.damage >= threshold) {
    damageMap.delete(key);
    const type = block.typeId;
    block.setType("minecraft:air");
    tryFx(() => dim.playSound("dig.stone", center));
    tryFx(() => dim.spawnParticle("minecraft:large_explosion", center));
    emit("breach", { block: type, at: block.location, by: source });
    return true;
  }
  damageMap.set(key, entry);
  // Crack feedback: more particles as the block nears its threshold.
  const bursts = 1 + Math.floor((entry.damage / threshold) * 3);
  for (let i = 0; i < bursts; i++) tryFx(() => dim.spawnParticle("minecraft:critical_hit_emitter", center));
  tryFx(() => dim.playSound("hit.stone", center));
  return true;
}

function tryFx(fn) {
  try {
    fn();
  } catch {
    // cosmetic only
  }
}

function decay(seconds) {
  const rate = getConfig().decay_rate * seconds;
  if (!rate) return;
  const dim = overworld();
  for (const [key, entry] of damageMap) {
    entry.damage -= rate;
    const [x, y, z] = key.split(",").map(Number);
    let current;
    try {
      current = dim.getBlock({ x, y, z });
    } catch {
      current = undefined; // unloaded; let it decay away
    }
    if (entry.damage <= 0 || (current && current.typeId !== entry.type)) damageMap.delete(key);
  }
}

export function damagedBlocks() {
  return damageMap.size;
}

// ---------------------------------------------------------------- stuck

/** First breachable block between a stuck mob and the core (whose feet are
 * at `core`): straight up or down when the mob is right under or over it,
 * otherwise ahead at feet and head height (plus one up or down when the core
 * is higher or lower), straight on or 35 degrees either side. */
function breachTarget(mob, core) {
  const p = mob.location;
  const dx = core.x - p.x;
  const dz = core.z - p.z;
  const gap = core.y - p.y;
  const feet = Math.floor(p.y + 0.01);
  const dim = mob.dimension;
  const column = (dys) => {
    for (const dy of dys) {
      const block = dim.getBlock({ x: Math.floor(p.x), y: feet + dy, z: Math.floor(p.z) });
      if (isBreachable(block)) return block;
    }
    return undefined;
  };
  if (Math.hypot(dx, dz) < 1.5) {
    if (gap > 0.5) return column([2, 3]);
    if (gap < -0.5) return column([-1]);
  }
  const len = Math.hypot(dx, dz) || 1;
  const heights = gap >= 1 ? [0, 1, 2] : gap <= -1 ? [-1, 0, 1] : [0, 1];
  for (const angle of [0, 0.6, -0.6]) {
    const ux = (dx / len) * Math.cos(angle) - (dz / len) * Math.sin(angle);
    const uz = (dx / len) * Math.sin(angle) + (dz / len) * Math.cos(angle);
    for (const step of [0.7, 1.3]) {
      for (const dy of heights) {
        const block = dim.getBlock({ x: Math.floor(p.x + ux * step), y: feet + dy, z: Math.floor(p.z + uz * step) });
        if (isBreachable(block)) return block;
      }
    }
  }
  return undefined;
}

function sample(mob, core) {
  const p = mob.location;
  const dist = Math.hypot(p.x - core.x, p.z - core.z);
  let state = tracking.get(mob.id);
  if (!state) {
    state = { history: [], stuckSince: undefined, detonated: false };
    tracking.set(mob.id, state);
  }
  state.history.push({ x: p.x, z: p.z, dist });
  if (state.history.length > WINDOW) state.history.shift();
  const first = state.history[0];
  // In reach means close in 3D: a mob tunnelled in under the core is near
  // horizontally but can't hit it.
  const inReach = dist < REACH && Math.abs(core.y - p.y) < 1.5;
  const stuck =
    state.history.length === WINDOW &&
    Math.hypot(p.x - first.x, p.z - first.z) < STUCK_MOVED &&
    first.dist - dist < STUCK_CLOSING &&
    !inReach;
  if (stuck && state.stuckSince === undefined) state.stuckSince = system.currentTick;
  if (!stuck) state.stuckSince = undefined;
  return state;
}

const VOLLEY_TICKS = 30;
const ARROW_SPEED = 1.4; // blocks per tick
const ARROW_GRAVITY = 0.05; // blocks per tick², vanilla arrow

const ARTILLERY_RANGE = 64;
// Artillery carriers are nudged in until they are this close (horizontally)
// and no higher than this above the core, so they fire down over hills
// and walls instead of into them (ghast AI won't close in on its own).
const ARTILLERY_STANDOFF = 18;
const ARTILLERY_CEILING = 30;
const NUDGE = 0.06;
const FIREBALL_SPEED = 1.2; // blocks per tick; fireballs fly straight

/** artillery: every interval_s, a carrier within range fires a fireball
 * straight at the core. The vanilla ghast AI won't reliably fire on a
 * non-player target from where it floats, so this does it. The vanilla
 * fireball is not summonable; dm:fireball is a copy that is. */
function artillery(mob, state, core, params) {
  const p = mob.location;
  const flat = Math.hypot(core.x - p.x, core.z - p.z);
  const above = p.y - core.y;
  const push = {
    x: flat > ARTILLERY_STANDOFF ? ((core.x - p.x) / flat) * NUDGE : 0,
    y: above > ARTILLERY_CEILING ? -NUDGE : 0,
    z: flat > ARTILLERY_STANDOFF ? ((core.z - p.z) / flat) * NUDGE : 0,
  };
  if (push.x || push.y || push.z) tryFx(() => mob.applyImpulse(push));
  const now = system.currentTick;
  if (now - (state.lastShot ?? 0) < params.interval_s * 20) return;
  const from = mob.getHeadLocation();
  const dx = core.x - from.x;
  const dy = core.y + 0.5 - from.y;
  const dz = core.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > ARTILLERY_RANGE || dist < 3) return;
  state.lastShot = now;
  // Start a little in front of the mob so the fireball clears its own box.
  const start = { x: from.x + (dx / dist) * 2.5, y: from.y + (dy / dist) * 2.5, z: from.z + (dz / dist) * 2.5 };
  const fireball = mob.dimension.spawnEntity("dm:fireball", start);
  const projectile = fireball.getComponent("minecraft:projectile");
  if (!projectile) return fireball.remove();
  projectile.owner = mob;
  projectile.shoot({ x: (dx / dist) * FIREBALL_SPEED, y: (dy / dist) * FIREBALL_SPEED, z: (dz / dist) * FIREBALL_SPEED });
  tryFx(() => mob.dimension.playSound("mob.ghast.fireball", from));
}

/** Fires an arrow from the mob's head on an arc that lands on the core. */
function lobArrow(mob, core) {
  const from = mob.getHeadLocation();
  const dx = core.x - from.x;
  const dz = core.z - from.z;
  const dy = core.y + 0.5 - from.y;
  const flat = Math.hypot(dx, dz) || 1;
  const ticks = flat / ARROW_SPEED;
  // Ignores drag; good enough at wall range, and a miss still hits the wall.
  const vy = (dy + 0.5 * ARROW_GRAVITY * ticks * ticks) / ticks;
  const arrow = mob.dimension.spawnEntity("minecraft:arrow", from);
  const projectile = arrow.getComponent("minecraft:projectile");
  if (!projectile) return arrow.remove();
  projectile.owner = mob;
  projectile.shoot({ x: (dx / flat) * ARROW_SPEED, y: vy, z: (dz / flat) * ARROW_SPEED });
  tryFx(() => mob.dimension.playSound("random.bow", from));
}

function runModules(mob, state, core) {
  const modules = mobModules(mob);
  if (modules.dig) {
    const block = breachTarget(mob, core);
    if (block && addDamage(block, modules.dig.dps * SAMPLE_SECONDS, mob.typeId)) {
      tryFx(() => mob.playAnimation("animation.zombie.attack_bare_hand", { blendOutTime: 0.2 }));
    }
  }
  // Archers pressed against a wall can't see the core, so vanilla AI never
  // fires; a stuck carrier of siege_arrow lobs volleys toward the core
  // instead. Arrows that hit the wall chip it (see projectileHitBlock).
  if (modules.siege_arrow && system.currentTick - (state.lastVolley ?? 0) >= VOLLEY_TICKS) {
    state.lastVolley = system.currentTick;
    lobArrow(mob, core);
  }
  if (modules.detonate_stuck && !state.detonated) {
    const stuckFor = (system.currentTick - state.stuckSince) / 20;
    if (stuckFor >= modules.detonate_stuck.stuck_seconds) {
      state.detonated = true;
      mob.triggerEvent("dm:detonate");
      emit("detonate", { mob: mob.typeId, at: pos(mob.location) });
    }
  }
}

let decayClock = 0;

function tick() {
  decayClock += SAMPLE_SECONDS;
  if (decayClock >= 1) {
    decay(decayClock);
    decayClock = 0;
  }
  // Aim at the core entity's feet (on top of its block, or in it).
  const loc = coreLocation();
  if (!loc) return;
  const core = { ...coreCenter(loc), y: loc.inside ? loc.y : loc.y + 1 };
  const seen = new Set();
  const mobs = attackers().slice(0, getConfig().max_attackers);
  for (const mob of mobs) {
    seen.add(mob.id);
    try {
      const state = sample(mob, core);
      if (state.stuckSince !== undefined) runModules(mob, state, core);
      // Ranged modules that fire whether or not the mob is stuck.
      const params = mobModules(mob).artillery;
      if (params) artillery(mob, state, core, params);
    } catch {
      // the mob unloaded or died mid-sample
    }
  }
  for (const id of tracking.keys()) if (!seen.has(id)) tracking.delete(id);
}

// ---------------------------------------------------------------- events

export function startBreach() {
  system.runInterval(tick, SAMPLE_TICKS);

  // siege_arrow: an arrow from a module carrier chips the first block it hits,
  // then is spent (removed), or it would fall into the hole and drill on.
  // Blocks below the shooter's feet don't count, so archers chip what's in
  // front of them, not the ground they stand on.
  world.afterEvents.projectileHitBlock.subscribe((event) => {
    const shooter = event.source;
    if (!shooter?.isValid) return;
    const arrow = mobModules(shooter).siege_arrow;
    if (!arrow) return;
    const block = event.getBlockHit().block;
    if (block.y >= Math.floor(shooter.location.y)) addDamage(block, arrow.damage_per_hit, shooter.typeId);
    if (event.projectile.isValid) event.projectile.remove();
  });

  // Explosions never take out protected blocks (the core's block, bedrock...).
  world.beforeEvents.explosion.subscribe((event) => {
    const blocks = event.getImpactedBlocks();
    const kept = blocks.filter((block) => !isProtected(block));
    if (kept.length !== blocks.length) event.setImpactedBlocks(kept);
  });
}
