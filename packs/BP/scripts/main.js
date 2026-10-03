// Defend the Core: M0 spike.
//
// Answers the spike questions in docs/M0.md. Everything is driven by
// `/scriptevent dm:<action> <json>` from the BDS console, and every result is
// a `[DM] {json}` line in the server log.

import { system, world } from "@minecraft/server";
import { buildDepot, restockDepot } from "./depot.js";

const CORE_PROP = "dtc:core"; // world dynamic property: JSON {x, y, z, inside}
const ATTACKER_FAMILY = "dm_attacker";
const TARGETING = ["core_only", "prioritized", "nearest"];

let probe = { on: false, every: 20, handle: undefined };
/** entity id -> {x, z, dist} from the previous probe sample */
const lastSample = new Map();

// ---------------------------------------------------------------- output

function emit(type, data = {}) {
  console.log(`[DM] ${JSON.stringify({ t: type, tick: system.currentTick, ...data })}`);
}

function ack(msgId, data = {}) {
  emit("ack", { msg_id: msgId, ...data });
}

function nack(msgId, error) {
  emit("nack", { msg_id: msgId, error: String(error) });
}

const round = (n) => Math.round(n * 10) / 10;
const pos = (v) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

// ---------------------------------------------------------------- core

function overworld() {
  return world.getDimension("overworld");
}

function coreLocation() {
  const raw = world.getDynamicProperty(CORE_PROP);
  return typeof raw === "string" ? JSON.parse(raw) : undefined;
}

function coreEntity() {
  return overworld().getEntities({ type: "dm:core" })[0];
}

function coreCenter(loc) {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function coreHp(core) {
  const health = core?.getComponent("minecraft:health");
  return health ? { hp: health.currentValue, max: health.effectiveMax } : undefined;
}

function labelCore(core) {
  const hp = coreHp(core);
  if (hp) core.nameTag = `§bCore §f${Math.ceil(hp.hp)}/${hp.max}`;
}

function placeCore(loc, inside) {
  for (const old of overworld().getEntities({ type: "dm:core" })) old.remove();
  // On top of the block by default; `inside` tests whether mobs can still
  // reach an entity sitting in a solid block.
  const at = { x: loc.x + 0.5, y: inside ? loc.y : loc.y + 1, z: loc.z + 0.5 };
  const core = overworld().spawnEntity("dm:core", at);
  world.setDynamicProperty(CORE_PROP, JSON.stringify({ x: loc.x, y: loc.y, z: loc.z, inside }));
  labelCore(core);
  emit("core_set", { block: loc, entity: pos(core.location), inside, ...coreHp(core) });
  return core;
}

// ---------------------------------------------------------------- spawning

function spawnRing(msg) {
  const loc = coreLocation();
  if (!loc) throw new Error("no core set");
  const mob = msg.mob ?? "dm:zombie";
  if (!["dm:zombie", "dm:skeleton"].includes(mob)) throw new Error(`unknown mob ${mob}`);
  const targeting = msg.targeting ?? "prioritized";
  if (!TARGETING.includes(targeting)) throw new Error(`targeting must be one of ${TARGETING}`);
  const count = Math.min(Math.max(1, msg.count ?? 1), 20);
  const dist = msg.dist ?? 40;
  const bearing = ((msg.bearing ?? 0) * Math.PI) / 180; // 0 = north (-z), clockwise
  const spread = msg.spread ?? 3;

  const spawned = [];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(loc.x + Math.sin(bearing) * dist + (Math.random() - 0.5) * spread);
    const z = Math.floor(loc.z - Math.cos(bearing) * dist + (Math.random() - 0.5) * spread);
    const top = overworld().getTopmostBlock({ x, z });
    if (!top) throw new Error(`no ground at ${x},${z} (chunk not loaded?)`);
    const mobEntity = overworld().spawnEntity(mob, { x: x + 0.5, y: top.location.y + 1, z: z + 0.5 });
    mobEntity.triggerEvent(`dm:tgt_${targeting}`);
    mobEntity.setDynamicProperty("dtc:targeting", targeting);
    spawned.push({ id: mobEntity.id, at: pos(mobEntity.location) });
  }
  return { mob, targeting, spawned };
}

function attackers() {
  return overworld().getEntities({ families: [ATTACKER_FAMILY] });
}

// ---------------------------------------------------------------- probe

function sampleAttackers() {
  const loc = coreLocation();
  const center = loc && coreCenter(loc);
  const seen = new Set();
  for (const mob of attackers()) {
    seen.add(mob.id);
    const p = mob.location;
    const dist = center ? Math.hypot(p.x - center.x, p.z - center.z) : undefined;
    const prev = lastSample.get(mob.id);
    const moved = prev ? Math.hypot(p.x - prev.x, p.z - prev.z) : undefined;
    const closing = prev && dist !== undefined ? round(prev.dist - dist) : undefined;
    lastSample.set(mob.id, { x: p.x, z: p.z, dist });
    emit("probe", {
      id: mob.id,
      mob: mob.typeId,
      targeting: mob.getDynamicProperty("dtc:targeting"),
      at: pos(p),
      dist: dist === undefined ? undefined : round(dist),
      moved: moved === undefined ? undefined : round(moved),
      closing,
      hp: mob.getComponent("minecraft:health")?.currentValue,
    });
  }
  for (const id of lastSample.keys()) if (!seen.has(id)) lastSample.delete(id);
}

function setProbe(on, every) {
  if (probe.handle !== undefined) system.clearRun(probe.handle);
  probe = { on, every, handle: on ? system.runInterval(sampleAttackers, every) : undefined };
}

// ---------------------------------------------------------------- commands

const handlers = {
  // Upstream check: which console levels reach the BDS log.
  ping(msg) {
    console.info(`[DM-info] ping ${msg.msg_id ?? ""}`);
    console.warn(`[DM-warn] ping ${msg.msg_id ?? ""}`);
    return { pong: true, core: coreLocation() ?? null };
  },
  // Message length probe: send growing payloads and compare `len`.
  echo(_msg, raw) {
    return { len: raw.length, tail: raw.slice(-16) };
  },
  core_set(msg) {
    const { x, z } = msg;
    if (![x, z].every(Number.isInteger)) throw new Error("x and z must be integers");
    // Without y, the core goes on the surface block at x, z.
    const y = msg.y ?? overworld().getTopmostBlock({ x, z })?.location.y;
    if (!Number.isInteger(y)) throw new Error(`no ground at ${x},${z} (chunk not loaded?)`);
    if (msg.setblock) overworld().getBlock({ x, y, z })?.setType("minecraft:beacon");
    placeCore({ x, y, z }, Boolean(msg.inside));
    return {};
  },
  core_hp(msg) {
    const core = coreEntity();
    if (!core) throw new Error("no core entity");
    core.getComponent("minecraft:health").setCurrentValue(msg.hp);
    labelCore(core);
    return coreHp(core);
  },
  core_clear() {
    for (const core of overworld().getEntities({ type: "dm:core" })) core.remove();
    world.setDynamicProperty(CORE_PROP, undefined);
    return {};
  },
  tickingarea(msg) {
    const loc = coreLocation();
    if (!loc) throw new Error("no core set");
    const radius = Math.min(msg.radius ?? 4, 4); // chunks; 4 is the engine max
    overworld().runCommand(`tickingarea remove dtc_core`);
    const result = overworld().runCommand(
      `tickingarea add circle ${loc.x} ${loc.y} ${loc.z} ${radius} dtc_core`
    );
    return { radius_chunks: radius, success: result.successCount };
  },
  spawn(msg) {
    return spawnRing(msg);
  },
  targeting(msg) {
    if (!TARGETING.includes(msg.targeting)) throw new Error(`targeting must be one of ${TARGETING}`);
    const mobs = attackers();
    for (const mob of mobs) {
      mob.triggerEvent(`dm:tgt_${msg.targeting}`);
      mob.setDynamicProperty("dtc:targeting", msg.targeting);
    }
    return { changed: mobs.length };
  },
  probe(msg) {
    setProbe(msg.on !== false, Math.max(5, msg.every ?? 20));
    return { on: probe.on, every: probe.every };
  },
  status() {
    const core = coreEntity();
    return { core: coreLocation() ?? null, core_hp: coreHp(core) ?? null, attackers: attackers().length };
  },
  // Supply depot: {dist?: 50, x?, y?, z?, relocate?, path?: true}. Rebuilds
  // the existing depot in place; otherwise picks the flattest spot at `dist`
  // from the core unless x/z are given.
  depot(msg) {
    const loc = coreLocation();
    if (!loc) throw new Error("no core set");
    return buildDepot(loc, msg);
  },
  depot_restock() {
    return restockDepot();
  },
  kill_all() {
    const mobs = attackers();
    for (const mob of mobs) mob.remove();
    return { removed: mobs.length };
  },
};

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (!event.id.startsWith("dm:")) return;
  const action = event.id.slice(3);
  let msg = {};
  try {
    if (action !== "echo" && event.message.trim()) msg = JSON.parse(event.message);
  } catch (err) {
    return nack(undefined, `bad json: ${err}`);
  }
  const handler = handlers[action];
  if (!handler) return nack(msg.msg_id, `unknown action ${action}`);
  try {
    ack(msg.msg_id, { action, source: event.sourceType, ...handler(msg, event.message) });
  } catch (err) {
    nack(msg.msg_id, `${action}: ${err}`);
  }
});

// ---------------------------------------------------------------- world events

// The first beacon placed while no core exists becomes the core.
world.afterEvents.playerPlaceBlock.subscribe((event) => {
  if (event.block.typeId !== "minecraft:beacon" || coreLocation()) return;
  placeCore(event.block.location, false);
  emit("core_registered", { by: event.player.name, block: event.block.location });
});

world.afterEvents.entityHurt.subscribe(
  (event) => {
    const src = event.damageSource;
    labelCore(event.hurtEntity);
    emit("core_hurt", {
      damage: event.damage,
      cause: src.cause,
      by: src.damagingEntity?.typeId,
      projectile: src.damagingProjectile?.typeId,
      ...coreHp(event.hurtEntity),
    });
  },
  { entityTypes: ["dm:core"] }
);

world.afterEvents.entityDie.subscribe(
  (event) => {
    const src = event.damageSource;
    if (event.deadEntity.typeId === "dm:core") {
      world.setDynamicProperty(CORE_PROP, undefined);
      emit("game_over", { result: "lost", by: src.damagingEntity?.typeId, cause: src.cause });
    } else {
      emit("attacker_died", { mob: event.deadEntity.typeId, by: src.damagingEntity?.typeId, cause: src.cause });
    }
  },
  { entityTypes: ["dm:core", "dm:zombie", "dm:skeleton"] }
);

// Verifies the siege_arrow module's hook: does the hit report the shooter?
world.afterEvents.projectileHitBlock.subscribe((event) => {
  if (event.source?.typeId !== "dm:skeleton") return;
  const block = event.getBlockHit().block;
  emit("arrow_hit_block", { block: block.typeId, at: block.location, shooter: event.source.id });
});

world.afterEvents.worldLoad.subscribe(() => {
  emit("loaded", { core: coreLocation() ?? null });
});
