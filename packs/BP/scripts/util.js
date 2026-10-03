// Shared helpers: status output, dimension access, rounding.

import { system, world } from "@minecraft/server";

/** One `[DM] {json}` status line in the server log, read by the DM plugin. */
export function emit(type, data = {}) {
  console.log(`[DM] ${JSON.stringify({ t: type, tick: system.currentTick, ...data })}`);
}

export function overworld() {
  return world.getDimension("overworld");
}

export const round = (n) => Math.round(n * 10) / 10;
export const pos = (v) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });
export const blockKey = (v) => `${v.x},${v.y},${v.z}`;

/** A JSON value kept in a world dynamic property. */
export function stored(key, fallback) {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  world.setDynamicProperty(key, value === undefined ? undefined : JSON.stringify(value));
}
