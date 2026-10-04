// Supply depot: an open spruce pavilion with one labelled chest per starter
// kit, built on the flattest dry spot at a set distance from the core, with a
// path back to the core. Built and restocked by the DM (`dm:depot`,
// `dm:depot_restock`).

import { BlockPermutation, BlockVolume, EnchantmentType, ItemStack, SignSide, world } from "@minecraft/server";
import { COLUMNS, KITS } from "./kits.js";
import { spawnVendor } from "./shop.js";

const DEPOT_PROP = "dtc:depot"; // JSON {center, facing, chests: [{x, y, z, kit}]}
const HALF = 7; // the site is (2 * HALF + 1) blocks square
const UNSAFE_GROUND = ["water", "lava", "ice", "leaves", "log", "wood", "beacon"];
const PATH_GROUND = [
  "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt",
  "minecraft:podzol", "minecraft:mycelium", "minecraft:rooted_dirt",
];

// Quarter turns that point the layout's open side (local +z) at the core.
const ROTATIONS = {
  south: (dx, dz) => [dx, dz],
  west: (dx, dz) => [-dz, dx],
  north: (dx, dz) => [-dx, -dz],
  east: (dx, dz) => [dz, -dx],
};
const DIR_VECTORS = { south: [0, 1], west: [-1, 0], north: [0, -1], east: [1, 0] };
const SIGN_ROTATION = { south: 0, west: 4, north: 8, east: 12 };

function dirName([x, z]) {
  return Object.keys(DIR_VECTORS).find((k) => DIR_VECTORS[k][0] === x && DIR_VECTORS[k][1] === z);
}

class Builder {
  constructor(dimension, center, facing) {
    this.dim = dimension;
    this.center = center; // {x, y, z}; y is the floor level
    this.facing = facing;
    this.rotate = ROTATIONS[facing];
    this.errors = new Set();
  }

  at(dx, dy, dz) {
    const [rx, rz] = this.rotate(dx, dz);
    return { x: this.center.x + rx, y: this.center.y + dy, z: this.center.z + rz };
  }

  /** World direction name for a local one. */
  dir(local) {
    return dirName(this.rotate(...DIR_VECTORS[local]));
  }

  /** Local x axis in world terms, for logs laid along local x or z. */
  axis(localAxis) {
    const swapped = this.facing === "west" || this.facing === "east";
    return localAxis === "y" ? "y" : (localAxis === "x") !== swapped ? "x" : "z";
  }

  perm(ids, states = {}) {
    for (const id of [].concat(ids)) {
      try {
        return BlockPermutation.resolve(id, states);
      } catch {
        try {
          return BlockPermutation.resolve(id);
        } catch {
          // try the next id
        }
      }
    }
    this.errors.add(`block ${[].concat(ids).join("|")}`);
    return undefined;
  }

  set(dx, dy, dz, ids, states) {
    const perm = this.perm(ids, states);
    if (perm) this.dim.getBlock(this.at(dx, dy, dz))?.setPermutation(perm);
    return perm;
  }

  fill(x1, y1, z1, x2, y2, z2, ids, states) {
    const perm = this.perm(ids, states);
    if (perm) this.dim.fillBlocks(new BlockVolume(this.at(x1, y1, z1), this.at(x2, y2, z2)), perm);
  }

  /** A standing sign whose front faces the local direction `face`. */
  sign(dx, dy, dz, text, face = "south") {
    const perm = this.set(dx, dy, dz, ["minecraft:spruce_standing_sign", "minecraft:standing_sign"], {
      ground_sign_direction: SIGN_ROTATION[this.dir(face)],
    });
    if (!perm) return;
    const sign = this.dim.getBlock(this.at(dx, dy, dz))?.getComponent("minecraft:sign");
    sign?.setText(text, SignSide.Front);
    sign?.setText(text, SignSide.Back);
    sign?.setWaxed(true);
  }
}

// ---------------------------------------------------------------- site

function siteLoaded(dim, x, z) {
  return [-HALF, HALF].every((dx) =>
    [-HALF, HALF].every((dz) => dim.isChunkLoaded({ x: x + dx, y: 0, z: z + dz }))
  );
}

function candidates(core, dist) {
  const sites = [];
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    sites.push({ deg, x: Math.round(core.x + Math.sin(rad) * dist), z: Math.round(core.z - Math.cos(rad) * dist) });
  }
  return sites;
}

/** Whether every candidate site at `dist` from the core is loaded. */
export function depotSitesLoaded(core, dist = 50) {
  const dim = world.getDimension("overworld");
  return candidates(core, dist).every((s) => siteLoaded(dim, s.x, s.z));
}

function survey(dim, x, z) {
  if (!siteLoaded(dim, x, z)) return undefined;
  const heights = [];
  let unsafe = 0;
  for (let dx = -HALF; dx <= HALF; dx += 2) {
    for (let dz = -HALF; dz <= HALF; dz += 2) {
      const top = dim.getTopmostBlock({ x: x + dx, z: z + dz });
      if (!top) return undefined; // not loaded
      if (UNSAFE_GROUND.some((word) => top.typeId.includes(word))) unsafe++;
      heights.push(top.location.y);
    }
  }
  heights.sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const spread = heights[heights.length - 1] - heights[0];
  return { x, z, y: median, score: spread + unsafe * 4 };
}

function storedDepot() {
  const raw = world.getDynamicProperty(DEPOT_PROP);
  return typeof raw === "string" ? JSON.parse(raw) : undefined;
}

/**
 * Where to build: an explicit x/z (and optional y), the existing depot's spot
 * (a rebuild, unless `relocate`), or the best of 12 bearings at `dist` from
 * the core. A rebuild reuses the stored floor height, because surveying a
 * built site would read its roof as the ground.
 */
function chooseSite(dim, core, msg, existing) {
  if (Number.isInteger(msg.x) && Number.isInteger(msg.z)) {
    const same = existing && existing.center.x === msg.x && existing.center.z === msg.z;
    const y = msg.y ?? (same ? existing.center.y : survey(dim, msg.x, msg.z)?.y);
    if (!Number.isInteger(y)) throw new Error(`site ${msg.x},${msg.z} is not loaded`);
    return { x: msg.x, y, z: msg.z, score: 0 };
  }
  if (existing && !msg.relocate) return { ...existing.center, score: 0 };
  const dist = msg.dist ?? 50;
  let best;
  for (const { deg, x, z } of candidates(core, dist)) {
    const site = survey(dim, x, z);
    if (site && (!best || site.score < best.score)) best = { ...site, bearing: deg };
  }
  if (!best) throw new Error(`nothing loaded ${dist} blocks from the core; add a ticking area`);
  return best;
}

/** Which way the open side faces: the cardinal closest to the core. */
function facingToward(site, core) {
  const dx = core.x - site.x;
  const dz = core.z - site.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? "east" : "west";
  return dz > 0 ? "south" : "north";
}

// ---------------------------------------------------------------- structure

const SPRUCE_LOG = "minecraft:spruce_log";
const PLANKS = "minecraft:spruce_planks";
const SLAB = ["minecraft:spruce_slab", "minecraft:wooden_slab"];
const FENCE = ["minecraft:spruce_fence", "minecraft:fence"];
const BOTTOM = { "minecraft:vertical_half": "bottom" };

// Columns (local): back row facing the entrance, side rows facing inward.
// Each column is up to two barrels high (barrels never merge and open with
// a block on top), two blocks from the next, with a sign on top.
const CHEST_SPOTS = [
  [-4, -4, "south"], [-2, -4, "south"], [0, -4, "south"], [2, -4, "south"], [4, -4, "south"],
  [-4, -2, "east"], [-4, 0, "east"], [-4, 2, "east"],
  [4, -2, "west"], [4, 0, "west"], [4, 2, "west"],
];

function buildPavilion(b) {
  // Ground: solid footing, cleared air above, lawn, stone floor.
  b.fill(-HALF, -4, -HALF, HALF, -1, HALF, "minecraft:dirt");
  b.fill(-HALF, 1, -HALF, HALF, 14, HALF, "minecraft:air");
  b.fill(-HALF, 0, -HALF, HALF, 0, HALF, "minecraft:grass_block");
  b.fill(-5, 0, -5, 5, 0, 5, "minecraft:stone_bricks");
  b.fill(-3, 0, -3, 3, 0, 3, "minecraft:polished_andesite");
  b.fill(-1, 0, -1, 1, 0, 1, "minecraft:chiseled_stone_bricks");
  b.fill(0, 0, 6, 0, 0, HALF, ["minecraft:grass_path", "minecraft:dirt_path"]);

  // Frame: corner posts, a low fence on three sides, beams on top.
  for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
    b.fill(x, 1, z, x, 4, z, SPRUCE_LOG, { pillar_axis: "y" });
  }
  b.fill(-4, 1, -5, 4, 1, -5, FENCE);
  b.fill(-5, 1, -4, -5, 1, 4, FENCE);
  b.fill(5, 1, -4, 5, 1, 4, FENCE);
  b.fill(-5, 5, -5, 5, 5, -5, SPRUCE_LOG, { pillar_axis: b.axis("x") });
  b.fill(-5, 5, 5, 5, 5, 5, SPRUCE_LOG, { pillar_axis: b.axis("x") });
  b.fill(-5, 5, -4, -5, 5, 4, SPRUCE_LOG, { pillar_axis: b.axis("z") });
  b.fill(5, 5, -4, 5, 5, 4, SPRUCE_LOG, { pillar_axis: b.axis("z") });

  // Stepped roof with an overhang.
  b.fill(-6, 6, -6, 6, 6, 6, SLAB, BOTTOM);
  b.fill(-4, 6, -4, 4, 6, 4, PLANKS);
  b.fill(-3, 7, -3, 3, 7, 3, SLAB, BOTTOM);
  b.fill(-1, 7, -1, 1, 7, 1, PLANKS);
  b.set(0, 8, 0, SLAB, BOTTOM);

  // Light: hanging lanterns under the roof, lanterns on the corner beams.
  for (const [x, z] of [[0, 0], [-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    b.set(x, 5, z, "minecraft:lantern", { hanging: true });
  }
  for (const [x, z] of [[-6, 6], [6, 6]]) {
    b.set(x, 1, z, FENCE);
    b.set(x, 2, z, "minecraft:lantern", { hanging: false });
  }

  // Workstations by the entrance.
  b.set(-4, 1, 4, "minecraft:crafting_table");
  b.set(4, 1, 4, "minecraft:furnace", { "minecraft:cardinal_direction": b.dir("west") });

  // Beside the path: a path block under a sign turns back into dirt.
  b.sign(-2, 1, HALF,"§lSupply Depot§r\nDefend the Core\n§7alpha kits", "south");
}

const BARREL_FACING = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

// Where the vendors stand (local): the Quartermaster in the middle, the
// five skill vendors around him, clear of the barrel columns.
/** @type {[string, number, number][]} */
const VENDOR_SPOTS = [
  ["quartermaster", 0, 0],
  ["ranged", -2, -2],
  ["melee", 2, -2],
  ["armor", 0, -2],
  ["health", -2, 1],
  ["regen", 2, 1],
];

function placeVendor(b) {
  for (const [kind, x, z] of VENDOR_SPOTS) {
    const at = b.at(x, 1, z);
    spawnVendor({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, kind);
  }
}

function buildChests(b) {
  const chests = [];
  CHEST_SPOTS.forEach(([x, z, face], i) => {
    const kits = (COLUMNS[i] ?? []).map((id) => KITS.find((k) => k.id === id)).filter(Boolean);
    // Clear what an older depot left in the column (a chest, its sign).
    b.fill(x, 1, z, x, 3, z, "minecraft:air");
    kits.forEach((kit, level) => {
      b.set(x, 1 + level, z, "minecraft:barrel", { facing_direction: BARREL_FACING[b.dir(face)] });
      chests.push({ ...b.at(x, 1 + level, z), kit: kit.id });
    });
    if (!kits.length) return;
    // Top barrel first, as the column reads from the top.
    const text =
      kits.length > 1
        ? `§l${kits[1].label}§r\n§7(top)§r\n§l${kits[0].label}§r\n§7(bottom)`
        : `§l${kits[0].label}`;
    b.sign(x, 1 + kits.length, z, text, face);
  });
  return chests;
}

/** A 2-wide path from the depot entrance toward the core, with lamp posts. */
function buildPath(b, core) {
  const start = b.at(0, 0, HALF + 1);
  const dx = core.x + 0.5 - start.x;
  const dz = core.z + 0.5 - start.z;
  const length = Math.hypot(dx, dz) - 5; // stop short of the core's base
  const ux = dx / Math.hypot(dx, dz);
  const uz = dz / Math.hypot(dx, dz);
  const pathPerm = b.perm(["minecraft:grass_path", "minecraft:dirt_path"]);
  const fence = b.perm(FENCE);
  const lantern = b.perm("minecraft:lantern", { hanging: false });
  let laid = 0;
  for (let s = 0; s <= length; s += 0.5) {
    for (const side of [0, 1]) {
      const x = Math.floor(start.x + ux * s - uz * side);
      const z = Math.floor(start.z + uz * s + ux * side);
      const top = b.dim.getTopmostBlock({ x, z });
      if (top && pathPerm && PATH_GROUND.includes(top.typeId)) {
        // Plants on top of grass would sit on the path; clear them first.
        top.above()?.setType("minecraft:air");
        top.setPermutation(pathPerm);
        laid++;
      }
    }
    if (s > 0 && s % 10 === 0 && fence && lantern) {
      const x = Math.floor(start.x + ux * s + uz * 2);
      const z = Math.floor(start.z + uz * s - ux * 2);
      const top = b.dim.getTopmostBlock({ x, z });
      if (top && !UNSAFE_GROUND.some((w) => top.typeId.includes(w))) {
        top.above()?.setPermutation(fence);
        top.above(2)?.setPermutation(lantern);
      }
    }
  }
  return laid;
}

// ---------------------------------------------------------------- stocking

function enchant(item, enchants, errors) {
  const enchantable = item.getComponent("minecraft:enchantable");
  for (const [name, level] of Object.entries(enchants)) {
    try {
      enchantable.addEnchantment({ type: new EnchantmentType(name), level });
    } catch {
      errors.add(`enchant ${name} on ${item.typeId}`);
    }
  }
}

function stockChest(dim, spot, errors) {
  const kit = KITS.find((k) => k.id === spot.kit);
  const container = dim.getBlock(spot)?.getComponent("minecraft:inventory")?.container;
  if (!kit || !container) {
    errors.add(`chest ${spot.kit} at ${spot.x},${spot.y},${spot.z}`);
    return 0;
  }
  container.clearAll();
  let slot = 0;
  for (const [id, count, extra = {}] of kit.items) {
    if (extra.potion !== undefined) {
      // No stable API for potion types; potions don't stack, one per slot.
      for (let n = 0; n < count && slot < container.size; n++, slot++) {
        const r = dim.runCommand(
          `replaceitem block ${spot.x} ${spot.y} ${spot.z} slot.container ${slot} ${id} 1 ${extra.potion}`
        );
        if (!r.successCount) errors.add(`potion ${id}:${extra.potion}`);
      }
      continue;
    }
    if (slot >= container.size) {
      errors.add(`${kit.id} does not fit: ${id} and later items left out`);
      break;
    }
    let left = count;
    while (left > 0 && slot < container.size) {
      let item;
      try {
        item = new ItemStack(id);
      } catch {
        errors.add(`item ${id}`);
        break;
      }
      item.amount = Math.min(left, item.maxAmount);
      left -= item.amount;
      enchant(item, extra, errors);
      container.setItem(slot++, item);
    }
    if (left > 0 && slot >= container.size) errors.add(`${kit.id} does not fit: ${left} ${id} left out`);
  }
  return slot;
}

/** Put both vendors back where the depot keeps them. */
export function respawnVendors() {
  const depot = storedDepot();
  if (!depot) throw new Error("no depot built");
  placeVendor(new Builder(world.getDimension("overworld"), depot.center, depot.facing));
  return { at: depot.center };
}

export function restockDepot() {
  const depot = storedDepot();
  if (!depot) throw new Error("no depot built");
  const dim = world.getDimension("overworld");
  const errors = new Set();
  const slots = depot.chests.reduce((n, spot) => n + stockChest(dim, spot, errors), 0);
  return { chests: depot.chests.length, slots, errors: [...errors] };
}

/** Knock a depot down to a lawn at its floor level. */
function demolish(dim, depot) {
  const old = new Builder(dim, depot.center, depot.facing);
  old.fill(-HALF, 1, -HALF, HALF, 14, HALF, "minecraft:air");
  old.fill(-HALF, 0, -HALF, HALF, 0, HALF, "minecraft:grass_block");
  world.setDynamicProperty(DEPOT_PROP, undefined);
}

export function buildDepot(core, msg) {
  const dim = world.getDimension("overworld");
  let existing = storedDepot();
  if (msg.containers_only) {
    // Swap the containers for the current layout and restock, leaving the
    // pavilion and anything players built around it alone. Items players
    // left in the old containers are lost.
    if (!existing) throw new Error("no depot built");
    const b = new Builder(dim, existing.center, existing.facing);
    const chests = buildChests(b);
    placeVendor(b);
    world.setDynamicProperty(DEPOT_PROP, JSON.stringify({ ...existing, chests }));
    const stock = restockDepot();
    return {
      center: existing.center,
      entrance: b.at(0, 1, HALF + 1),
      containers_only: true,
      ...stock,
      errors: [...b.errors, ...stock.errors],
    };
  }
  const explicit = Number.isInteger(msg.x) && Number.isInteger(msg.z);
  const moving =
    existing && (msg.relocate || (explicit && (msg.x !== existing.center.x || msg.z !== existing.center.z)));
  // Demolish before surveying, or the survey reads the old roof as ground.
  if (moving) {
    demolish(dim, existing);
    existing = undefined;
  }
  const site = chooseSite(dim, core, msg, existing);
  if (existing && site.y !== existing.center.y) demolish(dim, existing);
  const facing = facingToward(site, core);
  const b = new Builder(dim, { x: site.x, y: site.y, z: site.z }, facing);
  buildPavilion(b);
  const chests = buildChests(b);
  placeVendor(b);
  const path = msg.path === false ? 0 : buildPath(b, core);
  world.setDynamicProperty(DEPOT_PROP, JSON.stringify({ center: b.center, facing, chests }));
  const stock = restockDepot();
  return {
    center: b.center,
    entrance: b.at(0, 1, HALF + 1),
    bearing: site.bearing,
    facing,
    unevenness: site.score,
    path_blocks: path,
    ...stock,
    errors: [...b.errors, ...stock.errors],
  };
}
