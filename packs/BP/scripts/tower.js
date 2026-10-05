// Towers: between waves a procedurally generated tower rises near the
// depot, on the side away from the core. Every storey is a different room
// (a kind, see KINDS) with its own hazards: lava, cobwebs, arrow slits,
// pressure-plate mines, a collapsing floor, poison and flame vents, ice and
// magma, a maze. Guards hold their post in defense mode (they ignore the core
// and fight players who come close) and each floor has a loot chest, better
// the higher you climb, with a Captain on the throne floor at the top.
// Clearing every guard pays a bonus. The next tower replaces it.
//
// The ladder from one floor to the next is in the opposite corner, so every
// floor has to be crossed. Hazards that act on players (arrows, mines,
// crumbling tiles, vents) are "traps": small records kept with the tower and
// driven by one interval (`trapTick`). The tower is built as a job over
// several ticks; `tower_raised` is emitted when it is finished.

import { BlockPermutation, BlockVolume, GameMode, system, world } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { marketBounds } from "./market.js";
import { addCoins, payBounty } from "./economy.js";
import { addXp, killXp } from "./progression.js";
import { lootStack } from "./rewards.js";
import { emit, overworld, store, stored } from "./util.js";

const TOWER_PROP = "dtc:tower"; // {id, center, radius, top, floors, theme, kinds, guards, traps, building, porch, low}
const R = 8; // walls at |dx| or |dz| = R: a 17x17 tower with 15x15 floors (4.6x the old 7x7)
const IN = R - 1; // furthest interior offset
const FLOOR_H = 6; // floor to floor: the floor layer plus five blocks of air
const MIN_FLOORS = 2;
const MAX_FLOORS = 12;
const WORLD_TOP = 318; // keep the roof below the build limit
const LEASH = 14; // guards further than this from their post are brought back
const MAX_FILL = 30000; // fillBlocks refuses volumes past 32768
const GUARD_TYPES = ["dm:guard_zombie", "dm:guard_archer", "dm:guard_captain"];
const CLEAR_BONUS = { coins: 100, xp: 150 };
const PLATE = "minecraft:stone_pressure_plate";

const THEMES = [
  { name: "stone", wall: "minecraft:stone_bricks", accent: "minecraft:mossy_stone_bricks", floor: "minecraft:spruce_planks", trim: "minecraft:chiseled_stone_bricks" },
  { name: "deepslate", wall: "minecraft:deepslate_bricks", accent: "minecraft:cracked_deepslate_bricks", floor: "minecraft:dark_oak_planks", trim: "minecraft:chiseled_deepslate" },
  { name: "blackstone", wall: "minecraft:polished_blackstone_bricks", accent: "minecraft:cracked_polished_blackstone_bricks", floor: "minecraft:crimson_planks", trim: "minecraft:chiseled_polished_blackstone" },
  { name: "sandstone", wall: "minecraft:cut_sandstone", accent: "minecraft:chiseled_sandstone", floor: "minecraft:birch_planks", trim: "minecraft:smooth_sandstone" },
];

const rand = (n) => Math.floor(Math.random() * n);
const chance = (p) => Math.random() < p;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function towerRecord() {
  return stored(TOWER_PROP, undefined);
}

// What the trap loop reads (the stored record), dropped whenever it changes.
let trapCache;
let building = false;

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
  return { x, z, y: heights[Math.floor(heights.length / 2)], low: heights[0], score: heights[heights.length - 1] - heights[0] + bad * 4 };
}

/** Near the world spawn (the depot entrance), away from the core. */
function chooseSite(dim) {
  const spawn = world.getDefaultSpawnLocation();
  const core = coreLocation() ?? { x: spawn.x, z: spawn.z + 80 };
  const away = Math.atan2(spawn.z - core.z, spawn.x - core.x);
  // Market Street runs straight back from the depot: keep clear of it.
  const market = marketBounds(R + 3);
  const inMarket = (x, z) => market && x >= market.x1 && x <= market.x2 && z >= market.z1 && z <= market.z2;
  const depot = stored("dtc:depot", undefined)?.center;
  const nearDepot = (x, z) => depot && Math.abs(x - depot.x) < R + 12 && Math.abs(z - depot.z) < R + 12;
  let best;
  for (const dist of [38, 46, 30]) {
    for (const offset of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75]) {
      const a = away + offset;
      const x = Math.round(spawn.x + Math.cos(a) * dist);
      const z = Math.round(spawn.z + Math.sin(a) * dist);
      if (inMarket(x, z) || nearDepot(x, z)) continue;
      const site = survey(dim, x, z);
      if (site && (!best || site.score < best.score)) best = { ...site, toward: { x: spawn.x, z: spawn.z } };
    }
    if (best && best.score <= 4) break;
  }
  if (!best) throw new Error("no loaded ground near the spawn for a tower");
  return best;
}

// ---------------------------------------------------------------- blocks

function perm(id, states) {
  try {
    return BlockPermutation.resolve(id, states);
  } catch {
    return BlockPermutation.resolve(id);
  }
}

/** Fill a box (corners in any order), in slices small enough for fillBlocks. */
function fill(dim, a, b, id, states) {
  const p = perm(id, states);
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  const [z1, z2] = [Math.min(a.z, b.z), Math.max(a.z, b.z)];
  const slice = Math.max(1, Math.floor(MAX_FILL / ((x2 - x1 + 1) * (z2 - z1 + 1))));
  for (let y = y1; y <= y2; y += slice) {
    dim.fillBlocks(new BlockVolume({ x: x1, y, z: z1 }, { x: x2, y: Math.min(y2, y + slice - 1), z: z2 }), p);
  }
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

/** Where the ladder out of floor `i` stands: the corner alternates, so the
 * way up is always across the room from the way in. */
function corner(i) {
  return i % 2 === 0 ? { dx: IN, dz: -IN, face: 4 } : { dx: -IN, dz: IN, face: 5 };
}

// ---------------------------------------------------------------- one floor

/** One storey, in tower-local coordinates: dx/dz from the centre, h from the
 * floor layer (h 0 is the floor, 1..5 the room). */
class Floor {
  constructor(dim, site, index, floors, theme, difficulty, errors) {
    this.dim = dim;
    this.x = site.x;
    this.z = site.z;
    this.base = site.y + index * FLOOR_H;
    this.index = index;
    this.last = index === floors - 1;
    this.theme = theme;
    this.errors = errors;
    /** Danger, about 1 (low, early) to 3 (high, late, hard waves). */
    this.heat = Math.min(3, 1 + index * 0.2 + difficulty * 0.15);
    this.arrive = index > 0 ? corner(index - 1) : undefined;
    this.ascend = corner(index);
    const door = index === 0 ? doorSide(site, site.toward) : undefined;
    this.door = door ? { dx: door[0] - Math.sign(door[0]), dz: door[1] - Math.sign(door[1]) } : undefined;
    this.used = new Set();
    /** @type {any[][]} */
    this.traps = [];
    /** Explicit guards: {type, dx, h, dz}; otherwise `guardMul` and `archers` decide. */
    this.guardSpec = undefined;
    this.guardMul = 1;
    this.archers = 0.4;
    this.ringOnly = false;
    this.dark = false;
    /** @type {{dx: number, h?: number, dz: number} | undefined} */
    this.chest = undefined;
  }

  world(dx, h, dz) {
    return { x: this.x + dx, y: this.base + h, z: this.z + dz };
  }

  fill(dx1, h1, dz1, dx2, h2, dz2, id, states) {
    try {
      fill(this.dim, this.world(dx1, h1, dz1), this.world(dx2, h2, dz2), id, states);
    } catch (err) {
      this.fail(id, err);
    }
  }

  set(dx, h, dz, id, states) {
    try {
      setBlock(this.dim, this.world(dx, h, dz), id, states);
    } catch (err) {
      this.fail(id, err);
    }
  }

  fail(id, err) {
    const msg = `floor ${this.index} ${id}: ${err}`;
    if (this.errors.length < 12 && !this.errors.includes(msg)) this.errors.push(msg);
  }

  /** Keep guards, the chest and later decor off a block of cells. */
  take(dx1, dz1, dx2 = dx1, dz2 = dz1) {
    for (let dx = Math.min(dx1, dx2); dx <= Math.max(dx1, dx2); dx++) {
      for (let dz = Math.min(dz1, dz2); dz <= Math.max(dz1, dz2); dz++) this.used.add(`${dx},${dz}`);
    }
  }

  taken(dx, dz) {
    return this.used.has(`${dx},${dz}`);
  }

  /** A random free cell, away from the ladders and the door. `min`/`max` bound
   * the distance from the centre (Chebyshev); `pad` cells around it are taken. */
  spot({ min = 0, max = 6, pad = 1 } = {}) {
    const far = (dx, dz, c, r) => !c || Math.max(Math.abs(dx - c.dx), Math.abs(dz - c.dz)) >= r;
    for (let n = 0; n < 300; n++) {
      const dx = rand(2 * max + 1) - max;
      const dz = rand(2 * max + 1) - max;
      const ring = Math.max(Math.abs(dx), Math.abs(dz));
      if (ring < min || ring > max || this.taken(dx, dz)) continue;
      if (!far(dx, dz, this.arrive, 4) || !far(dx, dz, this.ascend, 3) || !far(dx, dz, this.door, 4)) continue;
      this.take(dx - pad, dz - pad, dx + pad, dz + pad);
      return { dx, dz };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- floor kinds
// Each builds the room's decor and hazards on a Floor. Guards and the chest
// are placed afterwards on whatever cells are still free.

/** Four pillars and stacked barrels. The gentle start. */
function barracks(f) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      f.fill(sx * 4, 1, sz * 4, sx * 4, FLOOR_H - 1, sz * 4, f.theme.trim);
      f.take(sx * 4, sz * 4);
    }
  }
  for (let n = 0; n < 8; n++) {
    const s = f.spot({ min: IN, max: IN, pad: 0 });
    if (!s) break;
    f.set(s.dx, 1, s.dz, "minecraft:barrel", { facing_direction: 1 });
    if (chance(0.5)) f.set(s.dx, 2, s.dz, "minecraft:barrel", { facing_direction: 1 });
  }
  f.guardMul = 1.3;
}

/** Bookshelf aisles hung with cobwebs: slow going under archers' eyes. */
function nest(f) {
  for (const dz of [-4, 0, 4]) {
    const gap = rand(8) - 4;
    for (let dx = -5; dx <= 5; dx++) {
      if (dx === gap || dx === gap + 1) continue;
      f.fill(dx, 1, dz, dx, 3, dz, "minecraft:bookshelf");
      f.take(dx, dz);
    }
  }
  const webs = 20 + Math.round(f.heat * 4);
  for (let n = 0; n < webs; n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (!s) break;
    const tall = 1 + rand(3);
    f.fill(s.dx, 1, s.dz, s.dx, tall, s.dz, "minecraft:web");
  }
  f.archers = 0.6;
}

/** Lava basins down both sides, magma underfoot and flame vents in the aisle. */
function furnace(f) {
  const flip = chance(0.5);
  const map = (a, b) => (flip ? [b, a] : [a, b]);
  for (const s of [-1, 1]) {
    // a is across the room (the basin), b along it.
    const [rx1, rz1] = map(s * 2, -5);
    const [rx2, rz2] = map(s * 6, 5);
    const [lx1, lz1] = map(s * 3, -4);
    const [lx2, lz2] = map(s * 5, 4);
    f.fill(rx1, 0, rz1, rx2, 0, rz2, f.theme.wall); // stone, not planks, under the lava
    f.fill(rx1, 1, rz1, rx2, 1, rz2, f.theme.wall); // the rim
    f.fill(lx1, 1, lz1, lx2, 1, lz2, "minecraft:lava");
    f.take(rx1, rz1, rx2, rz2);
  }
  for (let n = 0; n < 6 + Math.round(f.heat * 2); n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (!s) break;
    f.set(s.dx, 0, s.dz, "minecraft:magma");
  }
  for (const along of [-3, 3]) {
    const [dx, dz] = map(0, along);
    f.set(dx, 0, dz, "minecraft:magma");
    const at = f.world(dx, 0, dz);
    f.traps.push(["v", "f", at.x, at.y, at.z, 2, rand(24)]);
    f.take(dx - 2, dz - 2, dx + 2, dz + 2);
  }
  f.guardMul = 0.8;
  f.archers = 0.5;
}

/** Arrows from the side walls whenever someone crosses the room. */
function gauntlet(f) {
  let n = 0;
  for (const s of [-1, 1]) {
    for (const dz of [-4, -2, 2, 4]) {
      f.set(s * R, 2, dz, "minecraft:dispenser", { facing_direction: s === 1 ? 4 : 5 });
      const at = f.world(s * R, 2, dz);
      f.traps.push(["a", at.x, at.y, at.z, -s, 0, n++]);
    }
  }
  for (const [dx, dz] of [[-3, -3], [3, 3], [-3, 3], [3, -3], [0, -5], [0, 5], [0, 0]]) {
    f.fill(dx, 1, dz, dx, 3, dz, f.theme.trim);
    f.take(dx, dz);
  }
  f.guardMul = 0.7;
  f.archers = 0.3;
}

/** Pressure plates in the open: step on one and it blows up a second later. */
function minefield(f) {
  const plates = 12 + Math.round(f.heat * 3);
  for (let n = 0; n < plates; n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (!s) break;
    f.set(s.dx, 1, s.dz, PLATE);
    const at = f.world(s.dx, 1, s.dz);
    f.traps.push(["p", at.x, at.y, at.z]);
    f.take(s.dx - 1, s.dz - 1, s.dx + 1, s.dz + 1);
  }
  for (let n = 0; n < 6; n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (s) f.set(s.dx, 1, s.dz, "minecraft:cobblestone_wall");
  }
  f.archers = 0.6;
}

/** A cracked floor that drops away under your feet; the walkway round the edge holds. */
function crumble(f) {
  f.fill(-5, 0, -5, 5, 0, 5, f.theme.accent);
  const a = f.world(-5, 0, -5);
  const b = f.world(5, 0, 5);
  f.traps.push(["c", a.y, a.x, a.z, b.x, b.z, f.theme.accent]);
  f.take(-5, -5, 5, 5);
  f.chest = { dx: 0, dz: 0 };
  f.ringOnly = true;
  f.archers = 0.5;
}

/** Poison gas vents that hiss before they pulse, over soul sand. */
function toxic(f) {
  for (let n = 0; n < 14; n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (s) f.set(s.dx, 0, s.dz, "minecraft:soul_sand");
  }
  const vents = 3 + Math.round(f.heat);
  for (let n = 0; n < vents; n++) {
    const s = f.spot({ max: 5, pad: 2 });
    if (!s) break;
    f.set(s.dx, 1, s.dz, "minecraft:cauldron");
    const at = f.world(s.dx, 0, s.dz);
    f.traps.push(["v", "g", at.x, at.y, at.z, 3, rand(24)]);
  }
  f.archers = 0.5;
}

/** Slippery ice scattered with magma blocks. */
function frozen(f) {
  f.fill(-6, 0, -6, 6, 0, 6, "minecraft:packed_ice");
  for (let n = 0; n < 8 + Math.round(f.heat * 2); n++) {
    const s = f.spot({ max: 6, pad: 0 });
    if (!s) break;
    f.set(s.dx, 0, s.dz, "minecraft:magma");
  }
  for (let n = 0; n < 5; n++) {
    const s = f.spot({ max: 5, pad: 1 });
    if (s) f.fill(s.dx, 1, s.dz, s.dx, 2, s.dz, "minecraft:blue_ice");
  }
  f.archers = 0.5;
}

/** Walls from floor to ceiling: a maze with the chest in its farthest dead end. */
function maze(f) {
  f.dark = true;
  const size = 2 * IN + 1; // 15 grid squares a side
  const cells = (size + 1) / 2; // 8 cells a side
  const solid = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i % 2 === 1 || j % 2 === 1));
  const depth = new Map();
  // Cells sit on the even grid squares; the ladders stand in corner cells.
  const cellOf = (c) => [(c.dx + IN) / 2, (c.dz + IN) / 2];
  const start = cellOf(f.arrive ?? corner(1)); // the way in
  const exit = `${cellOf(f.ascend)}`;
  const seen = new Set([`${start}`]);
  depth.set(`${start}`, 0);
  const stack = [start];
  while (stack.length) {
    const [ci, cj] = stack[stack.length - 1];
    const next = shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]]).find(([di, dj]) => {
      const ni = ci + di;
      const nj = cj + dj;
      return ni >= 0 && nj >= 0 && ni < cells && nj < cells && !seen.has(`${ni},${nj}`);
    });
    if (!next) {
      stack.pop();
      continue;
    }
    const ni = ci + next[0];
    const nj = cj + next[1];
    solid[2 * ci + next[0]][2 * cj + next[1]] = false;
    seen.add(`${ni},${nj}`);
    depth.set(`${ni},${nj}`, depth.get(`${ci},${cj}`) + 1);
    stack.push([ni, nj]);
  }
  // A few extra openings, so there are loops as well as dead ends.
  for (let n = 0; n < 8; n++) {
    const gi = 1 + rand(size - 2);
    const gj = gi % 2 === 1 ? 2 * rand(cells) : 1 + 2 * rand(cells - 1);
    if (gj < size) solid[gi][gj] = false;
  }
  for (let gi = 0; gi < size; gi++) {
    for (let gj = 0; gj < size; gj++) {
      if (solid[gi][gj]) f.take(gi - IN, gj - IN);
    }
  }
  // Walls go up in runs along z.
  for (let gi = 0; gi < size; gi++) {
    let gj = 0;
    while (gj < size) {
      if (!solid[gi][gj]) {
        gj++;
        continue;
      }
      let end = gj;
      while (end + 1 < size && solid[gi][end + 1]) end++;
      f.fill(gi - IN, 1, gj - IN, gi - IN, FLOOR_H - 1, end - IN, chance(0.2) ? f.theme.accent : f.theme.wall);
      gj = end + 1;
    }
  }
  const cellAt = (key) => {
    const [ci, cj] = key.split(",").map(Number);
    return { dx: 2 * ci - IN, dz: 2 * cj - IN };
  };
  const ranked = [...depth.entries()].sort((a, b) => b[1] - a[1]);
  // The chest goes in the deepest true dead end, so it can't block the way through.
  const exits = (key) => {
    const [ci, cj] = key.split(",").map(Number);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => {
      const ni = ci + di;
      const nj = cj + dj;
      return ni >= 0 && nj >= 0 && ni < cells && nj < cells && !solid[2 * ci + di][2 * cj + dj];
    }).length;
  };
  const farthest = ranked.find(([key]) => key !== exit && key !== `${start}` && exits(key) === 1);
  if (farthest) {
    f.chest = cellAt(farthest[0]);
    f.take(f.chest.dx, f.chest.dz);
  }
  const deep = shuffle(ranked.filter(([, d]) => d >= 5).map(([key]) => key));
  f.guardSpec = [];
  const count = Math.min(deep.length, 3 + Math.round(f.heat * 1.5));
  for (let n = 0, placed = 0; n < deep.length && placed < count; n++) {
    const c = cellAt(deep[n]);
    if (deep[n] === exit || f.taken(c.dx, c.dz)) continue;
    f.take(c.dx, c.dz);
    f.guardSpec.push({ type: chance(0.35) ? "dm:guard_archer" : "dm:guard_zombie", dx: c.dx, h: 1, dz: c.dz });
    placed++;
  }
  // Dim light at a few junctions.
  for (let n = 0; n < 6; n++) {
    const key = `${rand(cells)},${rand(cells)}`;
    const c = cellAt(key);
    if (key !== `${start}` && key !== exit && !f.taken(c.dx, c.dz)) f.set(c.dx, FLOOR_H - 1, c.dz, "minecraft:soul_lantern", { hanging: true });
  }
}

/** The top floor: a dais with the Captain, archers on ledges, the best chest. */
function throne(f) {
  f.fill(-2, 2, -2, 2, 2, 2, "minecraft:red_carpet");
  f.fill(-2, 1, -2, 2, 1, 2, f.theme.trim);
  f.fill(-1, 1, -1, 1, 2, 1, f.theme.trim);
  f.take(-2, -2, 2, 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      f.fill(sx * 5, 1, sz * 5, sx * 5, FLOOR_H - 1, sz * 5, f.theme.trim);
      f.take(sx * 5, sz * 5);
    }
  }
  const ledges = [[-5, 0], [5, 0], [0, -5], [0, 5]];
  for (const [dx, dz] of ledges) {
    f.fill(dx - 1, 1, dz - 1, dx + 1, 1, dz + 1, f.theme.wall);
    f.take(dx - 1, dz - 1, dx + 1, dz + 1);
  }
  f.chest = { dx: 0, h: 3, dz: -1 };
  f.guardSpec = [
    { type: "dm:guard_captain", dx: 0, h: 3, dz: 1 },
    ...ledges.map(([dx, dz]) => ({ type: "dm:guard_archer", dx, h: 2, dz })),
  ];
  for (let n = 0; n < 2 + Math.round(f.heat); n++) {
    const s = f.spot({ min: 3, max: 6, pad: 1 });
    if (s) f.guardSpec.push({ type: "dm:guard_zombie", dx: s.dx, h: 1, dz: s.dz });
  }
}

// tier: 0 gentle, 1 harsh, 2 deadly. A floor only draws kinds up to its tier.
const KINDS = {
  barracks: { tier: 0, build: barracks },
  nest: { tier: 0, build: nest },
  frozen: { tier: 0, build: frozen },
  gauntlet: { tier: 1, build: gauntlet },
  minefield: { tier: 1, build: minefield },
  toxic: { tier: 1, build: toxic },
  crumble: { tier: 1, build: crumble },
  furnace: { tier: 2, build: furnace },
  maze: { tier: 2, build: maze },
  throne: { tier: 9, build: throne },
};
// A collapsing floor over lava, mines or ice would be cruel.
const NOT_ABOVE = { crumble: ["furnace", "minefield", "frozen"] };

/** The kind of each floor: gentle at the bottom, deadlier higher, the throne on top. */
function planKinds(floors) {
  const kinds = [];
  let bag = [];
  for (let i = 0; i < floors; i++) {
    if (i === floors - 1) {
      kinds.push("throne");
      continue;
    }
    const tier = i === 0 ? 0 : i <= 2 ? 1 : 2;
    const prev = kinds[i - 1];
    if (!bag.length) bag = shuffle(Object.keys(KINDS).filter((k) => k !== "throne"));
    const fits = (k) => KINDS[k].tier <= tier && k !== prev && !NOT_ABOVE[k]?.includes(prev);
    let pick = bag.find(fits);
    if (!pick) pick = shuffle(Object.keys(KINDS)).find((k) => k !== "throne" && fits(k)) ?? "barracks";
    if (bag.includes(pick)) bag.splice(bag.indexOf(pick), 1);
    kinds.push(pick);
  }
  return kinds;
}

// ---------------------------------------------------------------- building

function stockChest(dim, at, quality, tier, extra) {
  setBlock(dim, at, "minecraft:chest", { "minecraft:cardinal_direction": "south" });
  const container = dim.getBlock(at)?.getComponent("minecraft:inventory")?.container;
  if (!container) return;
  const count = 5 + rand(4) + quality * 2 + tier * 2;
  for (let i = 0; i < count; i++) container.setItem(rand(container.size), lootStack(quality));
  for (const stack of extra) container.addItem(stack);
}

function spawnGuard(dim, type, at, towerId) {
  const guard = dim.spawnEntity(type, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 });
  guard.setDynamicProperty("dtc:home", JSON.stringify(at));
  guard.setDynamicProperty("dtc:tower", towerId);
  return guard;
}

/** Walls, floor, windows and lights for one storey. */
function shell(f, theme) {
  const last = f.last;
  f.fill(-R - 1, 1, -R - 1, R + 1, FLOOR_H + (last ? 3 : 0), R + 1, "minecraft:air");
  f.fill(-R, 1, -R, R, FLOOR_H - 2, R, theme.wall);
  f.fill(-R, FLOOR_H - 1, -R, R, FLOOR_H - 1, R, theme.accent);
  f.fill(-IN, 1, -IN, IN, FLOOR_H - 1, IN, "minecraft:air");
  f.fill(-IN, 0, -IN, IN, 0, IN, theme.floor);
  f.fill(-R, 0, -R, R, 0, -R, theme.trim);
  f.fill(-R, 0, R, R, 0, R, theme.trim);
  f.fill(-R, 0, -R, -R, 0, R, theme.trim);
  f.fill(R, 0, -R, R, 0, R, theme.trim);
  // Windows: three to a side, sometimes barred.
  for (const off of [-5, 0, 5]) {
    for (const [wx, wz] of [[off, -R], [off, R], [-R, off], [R, off]]) {
      f.fill(wx, 2, wz, wx, 3, wz, chance(0.34) ? "minecraft:iron_bars" : "minecraft:air");
    }
  }
}

/** Hanging lanterns, unless the floor is meant to be dark. */
function lights(f) {
  if (f.dark) return;
  for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) f.set(dx, FLOOR_H - 1, dz, "minecraft:lantern", { hanging: true });
}

/** The ladder up from this floor, and its foot on the floor above. */
function ladders(f) {
  const { dx, dz, face } = f.ascend;
  f.fill(dx, 1, dz, dx, FLOOR_H - 1, dz, "minecraft:ladder", { facing_direction: face });
}

/** The ladder's arrival hole in this floor (its foot is built by the floor below). */
function arrival(f) {
  if (!f.arrive) return;
  const { dx, dz, face } = f.arrive;
  f.fill(dx, 0, dz, dx, 1, dz, "minecraft:ladder", { facing_direction: face });
}

function door(f, site, theme) {
  const [ddx, ddz] = doorSide(site, site.toward);
  const wide = ddz === 0 ? [0, 1] : [1, 0]; // along the wall
  f.fill(ddx - wide[0], 1, ddz - wide[1], ddx + wide[0], 3, ddz + wide[1], "minecraft:air");
  // A porch two blocks deep, so the doorstep meets the ground.
  const out = [Math.sign(ddx), Math.sign(ddz)];
  const a = f.world(ddx + out[0] - wide[0], 0, ddz + out[1] - wide[1]);
  const b = f.world(ddx + out[0] * 2 + wide[0], 0, ddz + out[1] * 2 + wide[1]);
  const porch = { x1: Math.min(a.x, b.x), z1: Math.min(a.z, b.z), x2: Math.max(a.x, b.x), z2: Math.max(a.z, b.z) };
  try {
    fill(f.dim, { x: porch.x1, y: f.base - 4, z: porch.z1 }, { x: porch.x2, y: f.base, z: porch.z2 }, theme.wall);
    fill(f.dim, { x: porch.x1, y: f.base + 1, z: porch.z1 }, { x: porch.x2, y: f.base + 4, z: porch.z2 }, "minecraft:air");
  } catch (err) {
    f.fail("porch", err);
  }
  return porch;
}

/** Build and populate floor `i`. Returns {guards, porch?}. */
function buildFloor(dim, site, i, floors, theme, kind, difficulty, towerId, errors, traps) {
  const f = new Floor(dim, site, i, floors, theme, difficulty, errors);
  shell(f, theme);
  arrival(f);
  const porch = f.door ? door(f, site, theme) : undefined;
  const def = KINDS[kind];
  def.build(f); // random cells (`spot`) already keep clear of the ladders and the door
  lights(f);
  ladders(f);

  // The chest: better the higher you climb, harder floors pay more.
  const quality = Math.min(3, 1 + Math.floor((i * 3) / floors) + (difficulty >= 6 ? 1 : 0));
  const extra = f.last ? [lootStack(3), lootStack(3)] : [];
  const chestAt = f.chest ?? f.spot({ pad: 1 });
  if (chestAt) {
    try {
      stockChest(dim, f.world(chestAt.dx, chestAt.h ?? 1, chestAt.dz), quality, def.tier === 9 ? 2 : def.tier, extra);
    } catch (err) {
      f.fail("chest", err);
    }
  }

  // Guards: more on higher floors and in harder waves.
  let guards = 0;
  const spec = f.guardSpec ?? [];
  if (!f.guardSpec) {
    const want = clamp(Math.round((2 + Math.floor(i / 3) + Math.floor(difficulty / 4)) * f.guardMul), 1, 6);
    for (let n = 0; n < want; n++) {
      const s = f.spot({ min: f.ringOnly ? 6 : 0, max: f.ringOnly ? IN : 6, pad: 1 });
      if (s) spec.push({ type: chance(f.archers) ? "dm:guard_archer" : "dm:guard_zombie", dx: s.dx, h: 1, dz: s.dz });
    }
  }
  for (const g of spec) {
    try {
      spawnGuard(dim, g.type, f.world(g.dx, g.h, g.dz), towerId);
      guards++;
    } catch (err) {
      f.fail(g.type, err);
    }
  }
  traps.push(...f.traps);
  return { guards, porch };
}

function roof(dim, site, floors, theme, errors) {
  const f = new Floor(dim, site, floors, floors + 1, theme, 0, errors);
  f.arrive = corner(floors - 1);
  f.fill(-R, 0, -R, R, 0, R, theme.wall);
  arrival(f);
  // The ladder's last rung needs something to hang on.
  f.set(f.arrive.dx + Math.sign(f.arrive.dx), 1, f.arrive.dz, theme.wall);
  for (let d = -R; d <= R; d++) {
    for (const [cx, cz] of [[d, -R], [d, R], [-R, d], [R, d]]) {
      if ((cx + cz + 2 * R) % 2 === 0) f.set(cx, 1, cz, theme.wall);
    }
  }
}

function* construct(dim, site, floors, theme, kinds, difficulty, record) {
  const errors = [];
  const traps = [];
  let guards = 0;
  let porch;
  try {
    const low = record.low;
    // Foundation, down to the lowest ground under the tower.
    fill(dim, { x: site.x - R, y: low, z: site.z - R }, { x: site.x + R, y: site.y, z: site.z + R }, theme.wall);
    yield;
    for (let i = 0; i < floors; i++) {
      const built = buildFloor(dim, site, i, floors, theme, kinds[i], difficulty, record.id, errors, traps);
      guards += built.guards;
      if (!porch) porch = built.porch;
      yield;
    }
    roof(dim, site, floors, theme, errors);
  } catch (err) {
    errors.push(String(err));
  }
  building = false;
  trapCache = undefined;
  store(TOWER_PROP, { ...record, building: false, guards, traps, porch });
  if (errors.length) emit("tower_error", { id: record.id, error: errors.join("; ") });
  emit("tower_raised", { id: record.id, at: record.center, floors, theme: theme.name, kinds, guards, traps: traps.length });
  world.sendMessage(
    `§5A ${theme.name} tower has risen near the spawn!§r ${floors} floors, ${guards} guards. Every floor is different, and some are deadly. Clear it for loot.`
  );
}

// ---------------------------------------------------------------- lifecycle

function guardsOf(towerId) {
  return overworld().getEntities({ families: ["dm_guard"] }).filter((g) => g.getDynamicProperty("dtc:tower") === towerId);
}

/** Take a tower down: guards gone, blocks cleared, lawn on top. */
export function removeTower() {
  if (building) throw new Error("the tower is still being built");
  const tower = towerRecord();
  if (!tower) return { removed: false };
  const dim = overworld();
  for (const guard of overworld().getEntities({ families: ["dm_guard"] })) guard.remove();
  const { x, y, z } = tower.center;
  const r = tower.radius ?? 4; // towers raised by older versions were 9x9
  try {
    fill(dim, { x: x - r - 1, y: y + 1, z: z - r - 1 }, { x: x + r + 1, y: tower.top + 3, z: z + r + 1 }, "minecraft:air");
    // Foundation (and the porch) back to earth with grass on top.
    fill(dim, { x: x - r, y: tower.low ?? y - 3, z: z - r }, { x: x + r, y: y - 1, z: z + r }, "minecraft:dirt");
    fill(dim, { x: x - r, y, z: z - r }, { x: x + r, y, z: z + r }, "minecraft:grass_block");
    const p = tower.porch;
    if (p) {
      fill(dim, { x: p.x1, y: y - 4, z: p.z1 }, { x: p.x2, y: y - 1, z: p.z2 }, "minecraft:dirt");
      fill(dim, { x: p.x1, y, z: p.z1 }, { x: p.x2, y, z: p.z2 }, "minecraft:grass_block");
    }
  } catch (err) {
    emit("tower_error", { error: `could not clear the old tower: ${err}` });
  }
  store(TOWER_PROP, undefined);
  trapCache = undefined;
  emit("tower_removed", { id: tower.id });
  return { removed: true };
}

/** {floors?: 2..12, difficulty?: 1..10} raises a new tower (replacing the old).
 * Without `floors` the height grows with the difficulty (about 4..6 at 2,
 * 8..10 at 10). It is built over several ticks: `tower_raised` marks the end. */
export function raiseTower(msg = {}) {
  if (building) throw new Error("a tower is still being built");
  const difficulty = clamp(msg.difficulty ?? 3, 1, 10);
  const wanted = Math.floor(msg.floors ?? 3 + Math.floor(difficulty / 2) + rand(3));
  removeTower();
  const dim = overworld();
  const site = chooseSite(dim);
  const floors = clamp(wanted, MIN_FLOORS, Math.min(MAX_FLOORS, Math.floor((WORLD_TOP - site.y - 3) / FLOOR_H)));
  const theme = THEMES[rand(THEMES.length)];
  const id = `tower${system.currentTick}`;
  const kinds = planKinds(floors);
  const center = { x: site.x, y: site.y, z: site.z };
  const low = Math.max(site.low - 1, site.y - 12);
  const record = { id, center, radius: R, top: site.y + floors * FLOOR_H, floors, theme: theme.name, kinds, guards: 0, traps: [], building: true, low };
  store(TOWER_PROP, record);
  trapCache = undefined;
  building = true;
  system.runJob(construct(dim, site, floors, theme, kinds, difficulty, record));
  return { id, at: center, floors, theme: theme.name, kinds, pending: true };
}

export function towerStatus() {
  const tower = towerRecord();
  if (!tower) return null;
  // The trap list is long; the status only says how many there are.
  const { traps, porch: _porch, ...rest } = tower;
  return { ...rest, traps: traps?.length ?? 0, alive: guardsOf(tower.id).length };
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

// ---------------------------------------------------------------- traps
// A trap is an array whose first item is its kind:
//   ["a", x, y, z, dx, dz, offset]        arrow slit at a wall block, firing along (dx, dz)
//   ["p", x, y, z]                        pressure plate that blows up
//   ["c", y, x1, z1, x2, z2, blockId]     tiles that collapse under a player
//   ["v", "g"|"f", x, y, z, radius, off]  gas or flame vent on the floor block

let runs = 0;
const crumbling = new Set();
let trapFault = false;

function sound(dim, id, at) {
  try {
    dim.playSound(id, at);
  } catch {
    // cosmetic
  }
}

function particle(dim, id, at) {
  try {
    dim.spawnParticle(id, at);
  } catch {
    // cosmetic
  }
}

const TRAPS = {
  a(dim, [, x, y, z, dx, dz, off], players) {
    if ((runs + off * 3) % 15 !== 0) return;
    let target;
    let nearest = 14;
    for (const p of players) {
      const l = p.location;
      if (Math.abs(l.y - y) > 3) continue;
      const along = (l.x - x - 0.5) * dx + (l.z - z - 0.5) * dz;
      const d = Math.hypot(l.x - x - 0.5, l.z - z - 0.5);
      if (along < 1 || d > nearest) continue;
      target = l;
      nearest = d;
    }
    if (!target) return;
    const from = { x: x + 0.5 + dx, y: y + 0.5, z: z + 0.5 + dz };
    const v = {
      x: target.x - from.x + (Math.random() - 0.5) * 0.8,
      y: target.y + 1.1 - from.y,
      z: target.z - from.z + (Math.random() - 0.5) * 0.8,
    };
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    const arrow = dim.spawnEntity("minecraft:arrow", from);
    arrow.getComponent("minecraft:projectile")?.shoot({ x: (v.x / len) * 1.3, y: (v.y / len) * 1.3, z: (v.z / len) * 1.3 });
  },

  p(dim, [, x, y, z], players) {
    for (const p of players) {
      const l = p.location;
      if (Math.abs(l.x - x - 0.5) > 0.65 || Math.abs(l.z - z - 0.5) > 0.65 || Math.abs(l.y - y) > 0.9) continue;
      const block = dim.getBlock({ x, y, z });
      if (block?.typeId !== PLATE) return;
      block.setType("minecraft:air");
      const at = { x: x + 0.5, y: y + 0.4, z: z + 0.5 };
      sound(dim, "random.click", at);
      system.runTimeout(() => {
        try {
          dim.createExplosion(at, 2.3, { breaksBlocks: false, causesFire: false });
        } catch {
          // chunk unloaded meanwhile
        }
      }, 14);
      return;
    }
  },

  c(dim, [, y, x1, z1, x2, z2, id], players) {
    for (const p of players) {
      if (!p.isOnGround) continue;
      const l = p.location;
      const bx = Math.floor(l.x);
      const bz = Math.floor(l.z);
      if (bx < x1 || bx > x2 || bz < z1 || bz > z2 || Math.abs(l.y - (y + 1)) > 0.3) continue;
      const key = `${bx},${y},${bz}`;
      if (crumbling.has(key)) continue;
      crumbling.add(key);
      particle(dim, "minecraft:basic_smoke_particle", { x: bx + 0.5, y: y + 1.1, z: bz + 0.5 });
      sound(dim, "dig.gravel", l);
      system.runTimeout(() => {
        crumbling.delete(key);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const x = bx + dx;
            const z = bz + dz;
            if (x < x1 || x > x2 || z < z1 || z > z2) continue;
            try {
              const block = dim.getBlock({ x, y, z });
              if (block?.typeId === id) block.setType("minecraft:air");
            } catch {
              // chunk unloaded meanwhile
            }
          }
        }
      }, 20);
    }
  },

  v(dim, [, kind, x, y, z, r, off], players) {
    const phase = (runs + off) % 24; // 5-tick runs: 8 of warning, 6 of venting, 10 quiet
    if (phase >= 14) return;
    const at = { x: x + 0.5, y: y + 1, z: z + 0.5 };
    if (phase < 8) {
      if (phase % 2 === 0) particle(dim, "minecraft:basic_smoke_particle", at);
      return;
    }
    particle(dim, kind === "f" ? "minecraft:basic_flame_particle" : "minecraft:villager_happy", { x: at.x + (Math.random() - 0.5) * r, y: at.y, z: at.z + (Math.random() - 0.5) * r });
    for (const p of players) {
      const l = p.location;
      if (Math.hypot(l.x - at.x, l.z - at.z) > r || Math.abs(l.y - y - 1) > 2.5) continue;
      if (kind === "f") p.setOnFire(3, true);
      else {
        p.addEffect("poison", 80, { amplifier: 0 });
        p.addEffect("slowness", 40, { amplifier: 0 });
      }
    }
  },
};

function trapTick() {
  runs++;
  if (trapCache === undefined) trapCache = towerRecord() ?? null;
  const tower = trapCache;
  if (!tower || tower.building || !tower.traps?.length) return;
  const { x, y, z } = tower.center;
  const r = (tower.radius ?? R) + 1;
  const dim = overworld();
  const players = dim.getPlayers().filter((p) => {
    const mode = p.getGameMode();
    if (mode === GameMode.Creative || mode === GameMode.Spectator) return false;
    const l = p.location;
    return Math.abs(l.x - x) <= r && Math.abs(l.z - z) <= r && l.y >= y && l.y <= tower.top + 3;
  });
  if (!players.length) return;
  for (const trap of tower.traps) {
    try {
      TRAPS[trap[0]]?.(dim, trap, players);
    } catch (err) {
      if (!trapFault) emit("tower_error", { error: `trap ${trap[0]}: ${err}` });
      trapFault = true;
    }
  }
}

export function startTowers() {
  system.runInterval(leash, 40);
  system.runInterval(trapTick, 5);
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
