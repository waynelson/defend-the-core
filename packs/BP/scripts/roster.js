// Attacker roster and breach module parameters. The DM plugin mirrors these
// (mob ids, module names and ranges) for its own validation.

export const MOBS = {
  "dm:zombie": { label: "Siege Zombie", modules: {} },
  "dm:skeleton": { label: "Siege Skeleton", modules: {} },
  "dm:swarmer": { label: "Swarmer", modules: { dig: { dps: 0.5 } } },
  "dm:digger": { label: "Digger", modules: { dig: { dps: 1.5 } } },
  "dm:sapper": { label: "Sapper", modules: { detonate_stuck: { stuck_seconds: 6 } } },
  "dm:siege_skeleton": { label: "Siege Archer", modules: { siege_arrow: { damage_per_hit: 1.5 } } },
  // Flyers spawn spawn_height blocks above the ground and ignore walls.
  // Ghasts with player targeting rise out of firing range and stall
  // (tested), so they default to the core only.
  "dm:ghast": { label: "Siege Ghast", modules: { artillery: { interval_s: 5 } }, spawn_height: 8, targeting: "core_only" },
  // Blazes walk on vanilla AI and snag on terrain; fly_in carries them in.
  "dm:blaze": { label: "Blaze", modules: { fly_in: { standoff: 14, height: 5 } }, spawn_height: 8 },
  "dm:phantom": { label: "Phantom", modules: {}, spawn_height: 18 },
  // Bosses: big and tough, with a boss bar; announced when they arrive and
  // when they fall. The Necromancer keeps raising swarmers (summon).
  "dm:warlord": { label: "Warlord", modules: { dig: { dps: 4 } }, boss: true },
  "dm:colossus": { label: "Bone Colossus", modules: { siege_arrow: { damage_per_hit: 5 } }, boss: true },
  "dm:necromancer": { label: "Necromancer", modules: { summon: { interval_s: 12, count: 3 } }, boss: true },
  "dm:demolisher": { label: "Demolisher", modules: { detonate_stuck: { stuck_seconds: 3 } }, boss: true },
  "dm:dread_ghast": {
    label: "Dread Ghast", modules: { artillery: { interval_s: 2.5 } }, spawn_height: 10, targeting: "core_only", boss: true,
  },
};

/** Module name -> param name -> [min, max]. */
export const MODULES = {
  dig: { dps: [0.1, 10] },
  detonate_stuck: { stuck_seconds: [1, 60] },
  siege_arrow: { damage_per_hit: [0.1, 20] },
  artillery: { interval_s: [2, 30] },
  summon: { interval_s: [3, 60], count: [1, 10] },
  fly_in: { standoff: [4, 40], height: [0, 20] },
};

export const TARGETING = ["core_only", "prioritized", "nearest"];

/** The mob's default modules with `overrides` applied; throws on anything
 * unknown or out of range. `{module: null}` removes a default module. */
export function resolveModules(mob, overrides = {}) {
  const def = MOBS[mob];
  if (!def) throw new Error(`unknown mob ${mob}`);
  const modules = JSON.parse(JSON.stringify(def.modules));
  for (const [name, params] of Object.entries(overrides ?? {})) {
    const schema = MODULES[name];
    if (!schema) throw new Error(`unknown module ${name}`);
    if (params === null) {
      delete modules[name];
      continue;
    }
    const merged = { ...modules[name] };
    for (const [key, value] of Object.entries(params)) {
      const range = schema[key];
      if (!range) throw new Error(`unknown param ${name}.${key}`);
      if (typeof value !== "number" || value < range[0] || value > range[1]) {
        throw new Error(`${name}.${key} must be a number in ${range[0]}..${range[1]}`);
      }
      merged[key] = value;
    }
    for (const key of Object.keys(schema)) {
      if (merged[key] === undefined) throw new Error(`${name}.${key} is required`);
    }
    modules[name] = merged;
  }
  return modules;
}
