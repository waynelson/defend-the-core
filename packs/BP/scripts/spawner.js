// Spawning attackers and finding the live ones.

import { coreLocation } from "./core.js";
import { MOBS, TARGETING, resolveModules } from "./roster.js";
import { overworld, stored } from "./util.js";

export const ATTACKER_FAMILY = "dm_attacker";
const POINTS_PROP = "dtc:points"; // {name: {x, z}}

export function attackers() {
  return overworld().getEntities({ families: [ATTACKER_FAMILY] });
}

export function spawnPoints() {
  return stored(POINTS_PROP, {});
}

/** Where a spawn spec points: a named point, x/z, or bearing/dist from the core. */
export function spawnCenter(spec) {
  if (spec.point !== undefined) {
    const point = spawnPoints()[spec.point];
    if (!point) throw new Error(`unknown spawn point ${spec.point}`);
    return point;
  }
  if (Number.isInteger(spec.x) && Number.isInteger(spec.z)) return { x: spec.x, z: spec.z };
  const core = coreLocation();
  if (!core) throw new Error("no core set");
  const dist = spec.dist ?? 40;
  const bearing = ((spec.bearing ?? 0) * Math.PI) / 180; // 0 = north (-z), clockwise
  return { x: Math.round(core.x + Math.sin(bearing) * dist), z: Math.round(core.z - Math.cos(bearing) * dist) };
}

/** Checks a spawn spec without spawning; returns the resolved modules. */
export function validateSpawn(spec) {
  if (!MOBS[spec.mob]) throw new Error(`unknown mob ${spec.mob}`);
  const targeting = spec.targeting ?? "prioritized";
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
  const mob = dim.spawnEntity(spec.mob, { x: x + 0.5, y: top.location.y + 1, z: z + 0.5 });
  const targeting = spec.targeting ?? "prioritized";
  mob.triggerEvent(`dm:tgt_${targeting}`);
  mob.setDynamicProperty("dtc:targeting", targeting);
  mob.setDynamicProperty("dtc:modules", JSON.stringify(modules));
  for (const [key, value] of Object.entries(tags)) mob.setDynamicProperty(key, value);
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
