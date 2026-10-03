// Player rewards: key survival items rain from the sky around the core.
//
// dm:rain {count?: 12, radius?: 12, duration_s?: 6, quality?: 2}. Items are
// drawn from POOL by weight for the chosen quality (1 basic, 2 good,
// 3 great) and dropped from ~20 blocks above the ground at random spots
// within `radius` of the core, spread over `duration_s`.

import { ItemStack, system } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { emit, overworld } from "./util.js";

// [item id, min, max, weights at quality 1, 2, 3]
/** @type {[string, number, number, number[]][]} */
const POOL = [
  ["minecraft:bread", 3, 8, [10, 6, 2]],
  ["minecraft:cooked_beef", 3, 8, [10, 7, 3]],
  ["minecraft:golden_carrot", 2, 6, [2, 5, 4]],
  ["minecraft:torch", 8, 16, [8, 4, 1]],
  ["minecraft:arrow", 8, 24, [8, 7, 4]],
  ["minecraft:cobblestone", 16, 32, [8, 5, 1]],
  ["minecraft:oak_planks", 8, 24, [6, 4, 1]],
  ["minecraft:coal", 4, 12, [6, 3, 1]],
  ["minecraft:iron_ingot", 2, 6, [4, 6, 4]],
  ["minecraft:stone_bricks", 16, 32, [3, 5, 3]],
  ["minecraft:iron_sword", 1, 1, [1, 4, 3]],
  ["minecraft:iron_pickaxe", 1, 1, [1, 3, 2]],
  ["minecraft:bow", 1, 1, [1, 3, 3]],
  ["minecraft:shield", 1, 1, [1, 3, 3]],
  ["minecraft:iron_helmet", 1, 1, [1, 3, 2]],
  ["minecraft:iron_chestplate", 1, 1, [0, 2, 2]],
  ["minecraft:golden_apple", 1, 2, [0, 3, 4]],
  ["minecraft:ender_pearl", 1, 3, [0, 2, 3]],
  ["minecraft:experience_bottle", 4, 12, [1, 3, 4]],
  ["minecraft:deepslate_bricks", 8, 16, [0, 2, 2]],
  ["minecraft:diamond", 1, 3, [0, 1, 4]],
  ["minecraft:diamond_sword", 1, 1, [0, 0, 2]],
  ["minecraft:diamond_chestplate", 1, 1, [0, 0, 1]],
  ["minecraft:enchanted_golden_apple", 1, 1, [0, 0, 1]],
  ["minecraft:totem_of_undying", 1, 1, [0, 0, 1]],
];
const DROP_HEIGHT = 20;

let rainRun;

function pick(quality) {
  const weights = POOL.map((entry) => entry[3][quality - 1]);
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < POOL.length; i++) {
    roll -= weights[i];
    if (roll < 0) return POOL[i];
  }
  return POOL[0];
}

function dropOne(core, radius, quality) {
  // Uniform over the disc, so the edge isn't sparse.
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * radius;
  const x = Math.floor(core.x + Math.cos(angle) * dist);
  const z = Math.floor(core.z + Math.sin(angle) * dist);
  const dim = overworld();
  if (!dim.isChunkLoaded({ x, y: 0, z })) return false;
  const ground = dim.getTopmostBlock({ x, z })?.location.y ?? core.y;
  const [id, min, max] = pick(quality);
  const item = new ItemStack(id);
  item.amount = Math.min(item.maxAmount, min + Math.floor(Math.random() * (max - min + 1)));
  const at = { x: x + 0.5, y: ground + DROP_HEIGHT, z: z + 0.5 };
  dim.spawnItem(item, at);
  try {
    dim.spawnParticle("minecraft:totem_particle", at);
  } catch {
    // cosmetic
  }
  return true;
}

export function startRain(msg) {
  const core = coreLocation();
  if (!core) throw new Error("no core set");
  if (rainRun !== undefined) throw new Error("it is already raining loot");
  const count = Math.min(Math.max(Math.floor(msg.count ?? 12), 1), 64);
  const radius = Math.min(Math.max(msg.radius ?? 12, 2), 48);
  const seconds = Math.min(Math.max(msg.duration_s ?? 6, 0), 30);
  const quality = Math.min(Math.max(Math.floor(msg.quality ?? 2), 1), 3);
  // Spread the drops evenly over the duration, at least one per tick.
  const ticks = Math.max(1, Math.round(seconds * 20));
  const perTick = count / ticks;
  let owed = 0;
  let dropped = 0;
  let missed = 0;
  let tick = 0;
  rainRun = system.runInterval(() => {
    owed += perTick;
    while (owed >= 1 && dropped + missed < count) {
      owed -= 1;
      if (dropOne(core, radius, quality)) dropped++;
      else missed++;
    }
    if (++tick >= ticks || dropped + missed >= count) {
      while (dropped + missed < count) {
        if (dropOne(core, radius, quality)) dropped++;
        else missed++;
      }
      system.clearRun(rainRun);
      rainRun = undefined;
      emit("rain_done", { dropped, missed });
    }
  }, 1);
  emit("rain", { count, radius, duration_s: seconds, quality });
  return { count, radius, duration_s: seconds, quality };
}
