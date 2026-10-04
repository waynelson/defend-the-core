// Towers: between waves a procedurally generated tower rises near the
// depot, on the side away from the core. Each floor holds guards in defense
// mode (they ignore the core, hold their post and fight players who come
// close) and a loot chest, better the higher you climb, with a Captain at
// the top. Clearing every guard pays a bonus. The next tower replaces it.

import { BlockPermutation, BlockVolume, system, world } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { marketBounds } from "./market.js";
import { addCoins, payBounty } from "./economy.js";
import { addXp, killXp } from "./progression.js";
import { lootStack } from "./rewards.js";
import { emit, overworld, store, stored } from "./util.js";

const TOWER_PROP = "dtc:tower"; // {id, center, radius, top, floors, theme}
const R = 4; // walls at |dx| or |dz| = R: a 9x9 tower
const FLOOR_H = 5;
const LEASH = 10; // guards further than this from their post are brought back
const GUARD_TYPES = ["dm:guard_zombie", "dm:guard_archer", "dm:guard_captain"];
const CLEAR_BONUS = { coins: 100, xp: 150 };

const THEMES = [
  { name: "stone", wall: "minecraft:stone_bricks", accent: "minecraft:mossy_stone_bricks", floor: "minecraft:spruce_planks", trim: "minecraft:chiseled_stone_bricks" },
  { name: "deepslate", wall: "minecraft:deepslate_bricks", accent: "minecraft:cracked_deepslate_bricks", floor: "minecraft:dark_oak_planks", trim: "minecraft:chiseled_deepslate" },
  { name: "blackstone", wall: "minecraft:polished_blackstone_bricks", accent: "minecraft:cracked_polished_blackstone_bricks", floor: "minecraft:crimson_planks", trim: "minecraft:chiseled_polished_blackstone" },
  { name: "sandstone", wall: "minecraft:cut_sandstone", accent: "minecraft:chiseled_sandstone", floor: "minecraft:birch_planks", trim: "minecraft:smooth_sandstone" },
];

const rand = (n) => Math.floor(Math.random() * n);

function towerRecord() {
  return stored(TOWER_PROP, undefined);
}

// ---------------------------------------------------------------- site

function survey(dim, x, z) {
  const heights = [];
  let bad = 0;
  for (let dx = -R - 1; dx <= R + 1; dx += 2) {
    for (let dz = -R - 1; dz <= R + 1; dz += 2) {
      if (!dim.isChunkLoaded({ x: x + dx, y: 0, z: z + dz })) return undefined;
      const top = dim.getTopmostBlock({ x: x + dx, z: z + dz });
      if (!top) return undefined;
      if (/water|lava|leaves|log|beacon|chest|barrel/.test(top.typeId)) bad++;
      heights.push(top.location.y);
    }
  }
  heights.sort((a, b) => a - b);
  return { x, z, y: heights[Math.floor(heights.length / 2)], score: heights[heights.length - 1] - heights[0] + bad * 4 };
}

/** Near the world spawn (the depot entrance), away from the core. */
function chooseSite(dim) {
  const spawn = world.getDefaultSpawnLocation();
  const core = coreLocation() ?? { x: spawn.x, z: spawn.z + 80 };
  const away = Math.atan2(spawn.z - core.z, spawn.x - core.x);
  // Market Street runs straight back from the depot: keep clear of it.
  const market = marketBounds(R + 3);
  const inMarket = (x, z) => market && x >= market.x1 && x <= market.x2 && z >= market.z1 && z <= market.z2;
  let best;
  for (const dist of [26, 32, 20]) {
    for (const offset of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75]) {
      const a = away + offset;
      const x = Math.round(spawn.x + Math.cos(a) * dist);
      const z = Math.round(spawn.z + Math.sin(a) * dist);
      if (inMarket(x, z)) continue;
      const site = survey(dim, x, z);
      if (site && (!best || site.score < best.score)) best = { ...site, toward: { x: spawn.x, z: spawn.z } };
    }
    if (best && best.score <= 3) break;
  }
  if (!best) throw new Error("no loaded ground near the spawn for a tower");
  return best;
}

// ---------------------------------------------------------------- building

function perm(id, states) {
  try {
    return BlockPermutation.resolve(id, states);
  } catch {
    return BlockPermutation.resolve(id);
  }
}

function fill(dim, a, b, id, states) {
  dim.fillBlocks(new BlockVolume(a, b), perm(id, states));
}

function setBlock(dim, at, id, states) {
  dim.getBlock(at)?.setPermutation(perm(id, states));
}

/** The side of the tower facing a point: [dx, dz] of the door. */
function doorSide(center, toward) {
  const dx = toward.x - center.x;
  const dz = toward.z - center.z;
  return Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx) * R, 0] : [0, Math.sign(dz) * R];
}

function build(dim, site, floors, theme) {
  const { x, y, z } = site;
  const top = y + floors * FLOOR_H;
  // Clear the site and lay a foundation.
  fill(dim, { x: x - R - 1, y: y + 1, z: z - R - 1 }, { x: x + R + 1, y: top + 3, z: z + R + 1 }, "minecraft:air");
  fill(dim, { x: x - R, y: y - 3, z: z - R }, { x: x + R, y, z: z + R }, theme.wall);

  for (let i = 0; i < floors; i++) {
    const base = y + i * FLOOR_H;
    // Floor (the ground floor sits on the foundation).
    if (i > 0) fill(dim, { x: x - R + 1, y: base, z: z - R + 1 }, { x: x + R - 1, y: base, z: z + R - 1 }, theme.floor);
    // Walls with accent courses and corner trim.
    for (let h = 1; h < FLOOR_H; h++) {
      const block = h === FLOOR_H - 1 ? theme.accent : theme.wall;
      fill(dim, { x: x - R, y: base + h, z: z - R }, { x: x + R, y: base + h, z: z - R }, block);
      fill(dim, { x: x - R, y: base + h, z: z + R }, { x: x + R, y: base + h, z: z + R }, block);
      fill(dim, { x: x - R, y: base + h, z: z - R }, { x: x - R, y: base + h, z: z + R }, block);
      fill(dim, { x: x + R, y: base + h, z: z - R }, { x: x + R, y: base + h, z: z + R }, block);
    }
    fill(dim, { x: x - R, y: base, z: z - R }, { x: x + R, y: base, z: z - R }, theme.trim);
    fill(dim, { x: x - R, y: base, z: z + R }, { x: x + R, y: base, z: z + R }, theme.trim);
    fill(dim, { x: x - R, y: base, z: z - R }, { x: x - R, y: base, z: z + R }, theme.trim);
    fill(dim, { x: x + R, y: base, z: z - R }, { x: x + R, y: base, z: z + R }, theme.trim);
    // Windows: the middle of each side, sometimes the off-centre spots too.
    for (const [wx, wz] of [[0, -R], [0, R], [-R, 0], [R, 0]]) {
      fill(dim, { x: x + wx, y: base + 2, z: z + wz }, { x: x + wx, y: base + 3, z: z + wz }, rand(3) ? "minecraft:air" : "minecraft:iron_bars");
      if (rand(2)) {
        const off = wx === 0 ? [2, 0] : [0, 2];
        setBlock(dim, { x: x + wx + off[0], y: base + 2, z: z + wz + off[1] }, "minecraft:air");
        setBlock(dim, { x: x + wx - off[0], y: base + 2, z: z + wz - off[1] }, "minecraft:air");
      }
    }
    // Lanterns in two corners.
    setBlock(dim, { x: x - R + 1, y: base + 1, z: z + R - 1 }, "minecraft:lantern", { hanging: false });
    setBlock(dim, { x: x + R - 1, y: base + FLOOR_H - 1, z: z + R - 1 }, "minecraft:lantern", { hanging: true });
  }

  // Roof and battlements.
  fill(dim, { x: x - R, y: top, z: z - R }, { x: x + R, y: top, z: z + R }, theme.wall);
  for (let d = -R; d <= R; d++) {
    for (const [cx, cz] of [[d, -R], [d, R], [-R, d], [R, d]]) {
      if ((cx + cz + 2 * R) % 2 === 0) setBlock(dim, { x: x + cx, y: top + 1, z: z + cz }, theme.wall);
    }
  }

  // A ladder up the inside of the east wall, through every floor and the roof.
  const lx = x + R - 1;
  const lz = z - R + 1;
  for (let ly = y + 1; ly <= top; ly++) setBlock(dim, { x: lx, y: ly, z: lz }, "minecraft:ladder", { facing_direction: 4 });

  // The door, on the side facing the spawn.
  const [ddx, ddz] = doorSide(site, site.toward);
  fill(dim, { x: x + ddx, y: y + 1, z: z + ddz }, { x: x + ddx, y: y + 3, z: z + ddz }, "minecraft:air");
  return top;
}

// ---------------------------------------------------------------- contents

function stockChest(dim, at, quality, extra) {
  setBlock(dim, at, "minecraft:chest", { "minecraft:cardinal_direction": "south" });
  const container = dim.getBlock(at)?.getComponent("minecraft:inventory")?.container;
  if (!container) return;
  const count = 5 + rand(4) + quality * 2;
  for (let i = 0; i < count; i++) container.setItem(rand(container.size), lootStack(quality));
  for (const stack of extra) container.addItem(stack);
}

function spawnGuard(dim, type, at, towerId) {
  const guard = dim.spawnEntity(type, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 });
  guard.setDynamicProperty("dtc:home", JSON.stringify(at));
  guard.setDynamicProperty("dtc:tower", towerId);
  return guard;
}

function populate(dim, site, floors, difficulty, towerId) {
  const { x, y, z } = site;
  let guards = 0;
  for (let i = 0; i < floors; i++) {
    const base = y + i * FLOOR_H;
    const last = i === floors - 1;
    // Better loot higher up; the top chest also gets something special.
    const quality = Math.min(3, 1 + Math.floor((i * 3) / floors) + (difficulty >= 6 ? 1 : 0));
    const extra = last ? [lootStack(3), lootStack(3)] : [];
    stockChest(dim, { x: x - R + 1, y: base + 1, z: z - R + 1 }, quality, extra);
    // Guards: more on higher floors and in later waves; archers at windows.
    const count = 1 + Math.floor(i / 2) + Math.floor(difficulty / 4);
    for (let n = 0; n < count; n++) {
      const type = n % 2 === 1 || (i > 0 && n === 0 && rand(2)) ? "dm:guard_archer" : "dm:guard_zombie";
      const spot = { x: x - 1 + rand(3), y: base + 1, z: z - 1 + rand(3) };
      spawnGuard(dim, type, spot, towerId);
      guards++;
    }
    if (last) {
      spawnGuard(dim, "dm:guard_captain", { x, y: base + 1, z }, towerId);
      guards++;
    }
  }
  return guards;
}

// ---------------------------------------------------------------- lifecycle

function guardsOf(towerId) {
  return overworld().getEntities({ families: ["dm_guard"] }).filter((g) => g.getDynamicProperty("dtc:tower") === towerId);
}

/** Take a tower down: guards gone, blocks cleared, lawn on top. */
export function removeTower() {
  const tower = towerRecord();
  if (!tower) return { removed: false };
  const dim = overworld();
  for (const guard of overworld().getEntities({ families: ["dm_guard"] })) guard.remove();
  const { x, y, z } = tower.center;
  try {
    fill(dim, { x: x - R - 1, y: y + 1, z: z - R - 1 }, { x: x + R + 1, y: tower.top + 3, z: z + R + 1 }, "minecraft:air");
    fill(dim, { x: x - R, y, z: z - R }, { x: x + R, y, z: z + R }, "minecraft:grass_block");
  } catch (err) {
    emit("tower_error", { error: `could not clear the old tower: ${err}` });
  }
  store(TOWER_PROP, undefined);
  emit("tower_removed", { id: tower.id });
  return { removed: true };
}

/** {floors?: 3..5, difficulty?: 1..10} raises a new tower (replacing the old). */
export function raiseTower(msg = {}) {
  const floors = Math.min(Math.max(Math.floor(msg.floors ?? 3 + rand(3)), 2), 6);
  const difficulty = Math.min(Math.max(msg.difficulty ?? 3, 1), 10);
  removeTower();
  const dim = overworld();
  const site = chooseSite(dim);
  const theme = THEMES[rand(THEMES.length)];
  const id = `tower${system.currentTick}`;
  const top = build(dim, site, floors, theme);
  const guards = populate(dim, site, floors, difficulty, id);
  const center = { x: site.x, y: site.y, z: site.z };
  store(TOWER_PROP, { id, center, radius: R, top, floors, theme: theme.name, guards });
  emit("tower_raised", { id, at: center, floors, theme: theme.name, guards });
  world.sendMessage(`§5A ${theme.name} tower has risen near the spawn!§r ${floors} floors, ${guards} guards. Clear it for loot.`);
  return { id, at: center, floors, theme: theme.name, guards };
}

export function towerStatus() {
  const tower = towerRecord();
  if (!tower) return null;
  return { ...tower, alive: guardsOf(tower.id).length };
}

/** Guards stay at their post. */
function leash() {
  for (const guard of overworld().getEntities({ families: ["dm_guard"] })) {
    const raw = guard.getDynamicProperty("dtc:home");
    if (typeof raw !== "string") continue;
    const home = JSON.parse(raw);
    const p = guard.location;
    if (Math.hypot(p.x - home.x - 0.5, p.y - home.y, p.z - home.z - 0.5) > LEASH) {
      guard.teleport({ x: home.x + 0.5, y: home.y, z: home.z + 0.5 });
    }
  }
}

export function startTowers() {
  system.runInterval(leash, 40);
  world.afterEvents.entityDie.subscribe(
    (event) => {
      const dead = event.deadEntity;
      const killer = event.damageSource.damagingEntity;
      const name = killer?.typeId === "minecraft:player" ? /** @type {import("@minecraft/server").Player} */ (killer).name : undefined;
      payBounty(dead.typeId, name);
      killXp(dead.typeId, name);
      const tower = towerRecord();
      if (!tower || dead.getDynamicProperty("dtc:tower") !== tower.id) return;
      // The dead guard may still count for a tick.
      system.run(() => {
        if (guardsOf(tower.id).length) return;
        emit("tower_cleared", { id: tower.id, by: name });
        world.sendMessage(`§a§lThe tower has been cleared!§r Everyone online: +${CLEAR_BONUS.coins} coins, +${CLEAR_BONUS.xp} XP.`);
        for (const player of world.getAllPlayers()) {
          addCoins(player, CLEAR_BONUS.coins, "tower cleared");
          addXp(player, CLEAR_BONUS.xp, "tower cleared");
        }
      });
    },
    { entityTypes: GUARD_TYPES }
  );
}
