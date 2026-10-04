// Spawning attackers and finding the live ones.

import { world } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { MOBS, TARGETING, resolveModules } from "./roster.js";
import { emit, overworld, store, stored } from "./util.js";

export const ATTACKER_FAMILY = "dm_attacker";
const POINTS_PROP = "dtc:points"; // {name: {x, z}}

export function attackers() {
  return overworld().getEntities({ families: [ATTACKER_FAMILY] });
}

export function spawnPoints() {
  return stored(POINTS_PROP, {});
}

function safeTopmost(dim, x, z) {
  if (!dim.isChunkLoaded({ x, y: 0, z })) return undefined;
  try {
    return dim.getTopmostBlock({ x, z });
  } catch {
    return undefined;
  }
}

/**
 * Auto-selects 4 good spawn points (north, east, south, west) at `dist`
 * blocks from the core, evaluating ground safety, no water in the way,
 * and walkable path terrain. Saves them to dtc:points and returns them.
 */
export function autoSelectPoints(dist = 80) {
  const core = coreLocation();
  if (!core) throw new Error("no core set");
  const dim = overworld();
  const cx = core.x;
  const cz = core.z;

  const depot = stored("dtc:depot");
  const depotCenter = depot?.center;

  function evaluateCandidate(bearing, quadCenter) {
    const rad = (bearing * Math.PI) / 180;
    const sx = Math.round(cx + Math.sin(rad) * dist);
    const sz = Math.round(cz - Math.cos(rad) * dist);

    // Keep clear of the depot / Market Street area
    if (depotCenter && Math.hypot(sx - depotCenter.x, sz - depotCenter.z) < 25) {
      return { score: Infinity, x: sx, z: sz, bearing };
    }

    const top = safeTopmost(dim, sx, sz);
    if (!top) return { score: Infinity, x: sx, z: sz, bearing };
    const sy = top.location.y;
    if (sy < -50 || sy > 300) return { score: Infinity, x: sx, z: sz, bearing };

    // Spawn point surface must not be water or lava
    if (top.typeId.includes("water") || top.typeId.includes("lava")) {
      return { score: Infinity, x: sx, z: sz, bearing };
    }

    // Check 3x3 footprint around the spawn point
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const nb = safeTopmost(dim, sx + dx, sz + dz);
        if (nb && (nb.typeId.includes("water") || nb.typeId.includes("lava"))) {
          return { score: Infinity, x: sx, z: sz, bearing };
        }
      }
    }

    // Check path to the core (step along the ray)
    let waterInPath = 0;
    let steepSteps = 0;
    let totalHeightDiff = 0;
    let prevY = sy;
    const steps = 16;
    for (let s = 1; s <= steps; s++) {
      const t = 1 - s / (steps + 1);
      const px = Math.round(cx + (sx - cx) * t);
      const pz = Math.round(cz + (sz - cz) * t);
      const block = safeTopmost(dim, px, pz);
      if (!block) continue;
      if (block.typeId.includes("water") || block.typeId.includes("lava")) {
        waterInPath++;
      }
      const py = block.location.y;
      const diff = Math.abs(py - prevY);
      if (diff > 2) steepSteps++;
      totalHeightDiff += diff;
      prevY = py;
    }

    const waterPenalty = waterInPath * 100000;
    const steepPenalty = steepSteps * 500;
    const angleDev = Math.abs((((bearing - quadCenter) % 360) + 540) % 360 - 180);
    const score = waterPenalty + steepPenalty + totalHeightDiff * 2 + angleDev * 0.5 + Math.abs(sy - (core.y ?? 65));
    return { score, x: sx, z: sz, bearing };
  }

  function pickQuadrant(bearings, centerDeg) {
    const cardinalRad = (centerDeg * Math.PI) / 180;
    const cardX = Math.round(cx + Math.sin(cardinalRad) * dist);
    const cardZ = Math.round(cz - Math.cos(cardinalRad) * dist);

    let best = null;
    for (const deg of bearings) {
      const res = evaluateCandidate(deg, centerDeg);
      if (!best || res.score < best.score) best = res;
    }

    return best && best.score < Infinity ? { x: best.x, z: best.z } : { x: cardX, z: cardZ };
  }

  const northBearings = [-30, -20, -10, 0, 10, 20, 30].map((b) => (b + 360) % 360);
  const eastBearings = [60, 70, 80, 90, 100, 110, 120];
  const southBearings = [150, 160, 170, 180, 190, 200, 210];
  const westBearings = [240, 250, 260, 270, 280, 290, 300];

  const points = {
    north: pickQuadrant(northBearings, 0),
    east: pickQuadrant(eastBearings, 90),
    south: pickQuadrant(southBearings, 180),
    west: pickQuadrant(westBearings, 270),
  };

  store(POINTS_PROP, points);
  emit("points", { points });
  return points;
}

/** Where a spawn spec points: a named point, x/z, or bearing/dist from the core. */
export function spawnCenter(spec) {
  if (spec.point !== undefined) {
    let point = spawnPoints()[spec.point];
    if (!point) {
      const all = spawnPoints();
      point = all[spec.point] || Object.values(all)[0];
    }
    if (point) return point;
  }
  if (Number.isInteger(spec.x) && Number.isInteger(spec.z)) return { x: spec.x, z: spec.z };
  if (spec.bearing === undefined) {
    const pts = Object.values(spawnPoints());
    if (pts.length > 0) return pts[Math.floor(Math.random() * pts.length)];
  }
  const core = coreLocation();
  if (!core) throw new Error("no core set");
  const dist = spec.dist ?? 80;
  const bearing = ((spec.bearing ?? 0) * Math.PI) / 180; // 0 = north (-z), clockwise
  return { x: Math.round(core.x + Math.sin(bearing) * dist), z: Math.round(core.z - Math.cos(bearing) * dist) };
}

/** Checks a spawn spec without spawning; returns the resolved modules. */
export function validateSpawn(spec) {
  if (!MOBS[spec.mob]) throw new Error(`unknown mob ${spec.mob}`);
  const targeting = spec.targeting ?? MOBS[spec.mob].targeting ?? "prioritized";
  if (!TARGETING.includes(targeting)) throw new Error(`targeting must be one of ${TARGETING}`);
  spawnCenter(spec);
  return resolveModules(spec.mob, spec.modules);
}

/** Spawns one attacker near `center` on the surface. Returns the entity, or
 * undefined if that spot isn't loaded yet. */
export function spawnOne(spec, center, modules, tags = {}) {
  const spread = spec.spread ?? 3;
  const x = Math.floor(center.x + (Math.random() - 0.5) * spread);
  const z = Math.floor(center.z + (Math.random() - 0.5) * spread);
  const dim = overworld();
  if (!dim.isChunkLoaded({ x, y: 0, z })) return undefined;
  const top = dim.getTopmostBlock({ x, z });
  if (!top) return undefined;
  const height = MOBS[spec.mob]?.spawn_height ?? 1;
  const mob = dim.spawnEntity(spec.mob, { x: x + 0.5, y: top.location.y + height, z: z + 0.5 });
  const targeting = spec.targeting ?? MOBS[spec.mob]?.targeting ?? "prioritized";
  mob.triggerEvent(`dm:tgt_${targeting}`);
  mob.setDynamicProperty("dtc:targeting", targeting);
  mob.setDynamicProperty("dtc:modules", JSON.stringify(modules));
  for (const [key, value] of Object.entries(tags)) mob.setDynamicProperty(key, value);
  if (MOBS[spec.mob]?.boss) {
    world.sendMessage(`§4§l[BOSS]§r §c${MOBS[spec.mob].label} has joined the attack!`);
    emit("boss_spawned", { mob: spec.mob, at: { x, y: Math.round(mob.location.y), z } });
  }
  return mob;
}

export function mobModules(mob) {
  const raw = mob.getDynamicProperty("dtc:modules");
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
