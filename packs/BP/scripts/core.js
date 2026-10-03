// The core: a dm:core entity on (or in) a block, its location in a world
// dynamic property.

import { emit, overworld, pos, store, stored } from "./util.js";

const CORE_PROP = "dtc:core"; // {x, y, z, inside}

export function coreLocation() {
  return stored(CORE_PROP, undefined);
}

export function coreEntity() {
  return overworld().getEntities({ type: "dm:core" })[0];
}

export function coreCenter(loc = coreLocation()) {
  return loc && { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

export function coreHp(core = coreEntity()) {
  const health = core?.getComponent("minecraft:health");
  return health ? { hp: Math.ceil(health.currentValue), max: health.effectiveMax } : undefined;
}

export function labelCore(core = coreEntity()) {
  const hp = coreHp(core);
  if (core && hp) core.nameTag = `§bCore §f${hp.hp}/${hp.max}`;
}

export function isCoreBlock(block) {
  const loc = coreLocation();
  return Boolean(loc) && block.x === loc.x && block.y === loc.y && block.z === loc.z;
}

export function placeCore(loc, inside) {
  for (const old of overworld().getEntities({ type: "dm:core" })) old.remove();
  // On top of the block by default; `inside` puts the entity in the block
  // (M0: mobs still reach it there).
  const at = { x: loc.x + 0.5, y: inside ? loc.y : loc.y + 1, z: loc.z + 0.5 };
  const core = overworld().spawnEntity("dm:core", at);
  store(CORE_PROP, { x: loc.x, y: loc.y, z: loc.z, inside });
  labelCore(core);
  emit("core_set", { block: loc, entity: pos(core.location), inside, ...coreHp(core) });
  return core;
}

export function clearCore() {
  for (const core of overworld().getEntities({ type: "dm:core" })) core.remove();
  store(CORE_PROP, undefined);
}

/** Forget the core after it dies (its entity is already gone). */
export function forgetCore() {
  store(CORE_PROP, undefined);
}
