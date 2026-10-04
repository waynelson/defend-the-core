// Market Street: the vendors' quarter behind the supply depot (on the side
// away from the core). An arch, a paved street with lamp posts, four themed
// shops on each side with a vendor at the counter, and a plaza with a
// fountain at the far end.
//
// Laid out in the depot's frame (local +z points at the core, so the street
// runs toward -z). Building it far from players needs its chunks loaded:
// a temporary ticking area covers it while it builds.

import { system, world } from "@minecraft/server";
import { depotBuilder } from "./depot.js";
import { spawnVendor } from "./shop.js";
import { emit } from "./util.js";

const MARKET_PROP = "dtc:market";
const AREA = "dtc_market";

const STREET_START = -8; // local z where the street leaves the depot
const STREET_END = -56;
const PLAZA = { z1: -57, z2: -71, half: 11 };
const SITE = { half: 12, z1: -8, z2: -72 };
const STALL = { inner: 4, depth: 8, length: 9, first: -12, pitch: 11 };

// [vendor kind, side (-1 west / +1 east of the street), slot from the depot]
const STALLS = [
  ["engineer", 1, 0],
  ["mason", -1, 0],
  ["provisioner", -1, 1],
  ["ranged", 1, 1],
  ["melee", -1, 2],
  ["armor", 1, 2],
  ["health", -1, 3],
  ["regen", 1, 3],
];

const THEMES = {
  engineer: {
    sign: "Engineer", sub: "turrets & traps",
    wall: "minecraft:deepslate_tiles", log: ["minecraft:stripped_dark_oak_log", "minecraft:dark_oak_log"],
    floor: "minecraft:smooth_stone", planks: "minecraft:dark_oak_planks",
    slab: ["minecraft:deepslate_tile_slab", "minecraft:dark_oak_slab"], counter: "minecraft:iron_block",
    awning: ["minecraft:orange_wool", "minecraft:black_wool"],
    decor: [["minecraft:dispenser"], ["minecraft:observer"], ["minecraft:redstone_block", "minecraft:redstone_lamp"], ["minecraft:piston"], ["minecraft:target"], ["minecraft:redstone_block", "minecraft:redstone_lamp"]],
  },
  mason: {
    sign: "Mason", sub: "blocks by the stack",
    wall: "minecraft:stone_bricks", log: ["minecraft:stripped_spruce_log", "minecraft:spruce_log"],
    floor: "minecraft:polished_andesite", planks: "minecraft:stone_bricks",
    slab: ["minecraft:stone_brick_slab"], counter: "minecraft:chiseled_stone_bricks",
    awning: ["minecraft:light_gray_wool", "minecraft:white_wool"],
    decor: [["minecraft:stonecutter_block"], ["minecraft:polished_granite"], ["minecraft:mossy_stone_bricks"], ["minecraft:polished_diorite"], ["minecraft:stonecutter_block"], ["minecraft:cut_sandstone"]],
  },
  provisioner: {
    sign: "Provisioner", sub: "tools, food & supplies",
    wall: "minecraft:oak_planks", log: ["minecraft:oak_log"],
    floor: "minecraft:spruce_planks", planks: "minecraft:oak_planks",
    slab: ["minecraft:oak_slab", "minecraft:wooden_slab"], counter: "minecraft:barrel",
    awning: ["minecraft:green_wool", "minecraft:white_wool"],
    decor: [["minecraft:barrel", "minecraft:barrel"], ["minecraft:hay_block"], ["minecraft:composter"], ["minecraft:smoker"], ["minecraft:hay_block", "minecraft:pumpkin"], ["minecraft:barrel"]],
  },
  ranged: {
    sign: "Bowyer", sub: "ranged skill & bows",
    wall: "minecraft:birch_planks", log: ["minecraft:birch_log"],
    floor: "minecraft:oak_planks", planks: "minecraft:birch_planks",
    slab: ["minecraft:birch_slab", "minecraft:wooden_slab"], counter: "minecraft:fletching_table",
    awning: ["minecraft:lime_wool", "minecraft:yellow_wool"],
    decor: [["minecraft:target"], ["minecraft:fletching_table"], ["minecraft:hay_block", "minecraft:target"], ["minecraft:fletching_table"], ["minecraft:target"], ["minecraft:hay_block"]],
  },
  melee: {
    sign: "Blacksmith", sub: "melee skill & blades",
    wall: "minecraft:polished_blackstone_bricks", log: ["minecraft:dark_oak_log"],
    floor: "minecraft:cobblestone", planks: "minecraft:dark_oak_planks",
    slab: ["minecraft:polished_blackstone_brick_slab", "minecraft:dark_oak_slab"], counter: "minecraft:smithing_table",
    awning: ["minecraft:red_wool", "minecraft:black_wool"],
    decor: [["minecraft:anvil"], ["minecraft:blast_furnace"], ["minecraft:grindstone"], ["minecraft:smithing_table"], ["minecraft:blast_furnace"], ["minecraft:iron_block"]],
  },
  armor: {
    sign: "Armorer", sub: "armour skill & enchants",
    wall: "minecraft:brick_block", log: ["minecraft:spruce_log"],
    floor: "minecraft:spruce_planks", planks: "minecraft:spruce_planks",
    slab: ["minecraft:brick_slab", "minecraft:spruce_slab"], counter: "minecraft:blast_furnace",
    awning: ["minecraft:blue_wool", "minecraft:white_wool"],
    decor: [["minecraft:smithing_table"], ["minecraft:anvil"], ["minecraft:iron_block"], ["minecraft:blast_furnace"], ["minecraft:anvil"], ["minecraft:gold_block"]],
  },
  health: {
    sign: "Healer", sub: "health skill & healing",
    wall: "minecraft:smooth_quartz", log: ["minecraft:birch_log"],
    floor: "minecraft:birch_planks", planks: "minecraft:birch_planks",
    slab: ["minecraft:smooth_quartz_slab", "minecraft:birch_slab"], counter: "minecraft:white_concrete",
    awning: ["minecraft:pink_wool", "minecraft:white_wool"],
    decor: [["minecraft:cauldron"], ["minecraft:moss_block", "minecraft:flowering_azalea"], ["minecraft:brewing_stand"], ["minecraft:cauldron"], ["minecraft:moss_block", "minecraft:flowering_azalea"], ["minecraft:honey_block"]],
  },
  regen: {
    sign: "Alchemist", sub: "regen skill & potions",
    wall: "minecraft:mud_bricks", log: ["minecraft:mangrove_log", "minecraft:jungle_log"],
    floor: "minecraft:mangrove_planks", planks: "minecraft:mangrove_planks",
    slab: ["minecraft:mud_brick_slab", "minecraft:mangrove_slab"], counter: "minecraft:bookshelf",
    awning: ["minecraft:purple_wool", "minecraft:magenta_wool"],
    decor: [["minecraft:brewing_stand"], ["minecraft:bookshelf", "minecraft:bookshelf"], ["minecraft:cauldron"], ["minecraft:amethyst_block"], ["minecraft:bookshelf", "minecraft:brewing_stand"], ["minecraft:brewing_stand"]],
  },
};

const BOTTOM = { "minecraft:vertical_half": "bottom" };
const FENCE = ["minecraft:dark_oak_fence", "minecraft:fence"];

export function marketBuilt() {
  return world.getDynamicProperty(MARKET_PROP) === true;
}

/** A shop's frame: (u from the street outward, v along the street) to the
 * builder's local (x, z). */
function stallFrame(side, slot) {
  const z0 = STALL.first - slot * STALL.pitch;
  return { x: (u) => side * (STALL.inner + u), z: (v) => z0 - v };
}

/** Market Street's footprint in world x/z (with a margin), or undefined. */
export function marketBounds(margin = 2) {
  if (!marketBuilt()) return undefined;
  let b;
  try {
    b = depotBuilder();
  } catch {
    return undefined;
  }
  const corners = [b.at(-SITE.half, 0, -4), b.at(SITE.half, 0, -4), b.at(-SITE.half, 0, SITE.z2), b.at(SITE.half, 0, SITE.z2)];
  return {
    x1: Math.min(...corners.map((c) => c.x)) - margin, x2: Math.max(...corners.map((c) => c.x)) + margin,
    z1: Math.min(...corners.map((c) => c.z)) - margin, z2: Math.max(...corners.map((c) => c.z)) + margin,
  };
}

function vendorSpot(b, side, slot) {
  const f = stallFrame(side, slot);
  const at = b.at(f.x(1), 1, f.z(2));
  return { x: at.x + 0.5, y: at.y, z: at.z + 0.5 };
}

/** A cheap repeatable "random" for street texture. */
function noise(x, z) {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// ---------------------------------------------------------------- parts

function* clearSite(b) {
  for (let z = SITE.z1; z >= SITE.z2; z -= 8) {
    const z2 = Math.max(SITE.z2, z - 7);
    b.fill(-SITE.half, -6, z, SITE.half, -1, z2, "minecraft:dirt");
    b.fill(-SITE.half, 1, z, SITE.half, 20, z2, "minecraft:air");
    b.fill(-SITE.half, 0, z, SITE.half, 0, z2, "minecraft:grass_block");
    yield;
  }
}

function* street(b) {
  // Through the back of the depot.
  b.fill(-1, 1, -5, 1, 4, -7, "minecraft:air");
  b.fill(-1, 0, -5, 1, 0, -7, "minecraft:stone_bricks");
  b.fill(-3, 0, STREET_START, 3, 0, STREET_END, "minecraft:stone_bricks");
  b.fill(-3, 0, STREET_START, -3, 0, STREET_END, "minecraft:polished_andesite");
  b.fill(3, 0, STREET_START, 3, 0, STREET_END, "minecraft:polished_andesite");
  yield;
  for (let z = STREET_START; z >= STREET_END; z--) {
    for (let x = -2; x <= 2; x++) {
      const r = noise(x, z);
      if (r < 0.12) b.set(x, 0, z, "minecraft:mossy_stone_bricks");
      else if (r < 0.22) b.set(x, 0, z, "minecraft:cracked_stone_bricks");
      else if (r < 0.27) b.set(x, 0, z, "minecraft:andesite");
    }
  }
  yield;
  // The arch.
  for (const x of [-4, 4]) b.fill(x, 1, -9, x, 5, -9, "minecraft:stone_bricks");
  b.fill(-4, 6, -9, 4, 6, -9, "minecraft:stone_bricks");
  b.fill(-3, 7, -9, 3, 7, -9, "minecraft:stone_brick_slab", BOTTOM);
  for (const x of [-2, 2]) b.set(x, 5, -9, "minecraft:lantern", { hanging: true });
  b.set(0, 7, -9, "minecraft:chiseled_stone_bricks");
  b.sign(0, 8, -9, "§lMarket Street§r\nshops & skills\n§7Defend the Core", "south");
  // Lamp posts in the gaps between the shops.
  for (let slot = 0; slot < 4; slot++) {
    const z = STALL.first - slot * STALL.pitch + 2;
    for (const x of [-3, 3]) {
      b.fill(x, 1, z, x, 3, z, FENCE);
      b.set(x, 4, z, "minecraft:lantern", { hanging: false });
    }
  }
  yield;
}

function* stall(b, kind, side, slot) {
  const t = THEMES[kind];
  const f = stallFrame(side, slot);
  const fill = (u1, y1, v1, u2, y2, v2, ids, states) => b.fill(f.x(u1), y1, f.z(v1), f.x(u2), y2, f.z(v2), ids, states);
  const set = (u, y, v, ids, states) => b.set(f.x(u), y, f.z(v), ids, states);
  const last = STALL.depth - 1;
  const end = STALL.length - 1;

  fill(0, 0, 0, last, 0, end, t.floor);
  fill(last, 1, 0, last, 4, end, t.wall); // back
  fill(0, 1, 0, last, 4, 0, t.wall); // sides
  fill(0, 1, end, last, 4, end, t.wall);
  for (const [u, v] of [[0, 0], [0, end], [last, 0], [last, end], [last, 4]]) fill(u, 1, v, u, 4, v, t.log);
  // Windows.
  fill(last, 2, 3, last, 3, 5, "minecraft:glass_pane");
  fill(3, 2, 0, 4, 3, 0, "minecraft:glass_pane");
  fill(3, 2, end, 4, 3, end, "minecraft:glass_pane");
  // Open front: a counter either side of the door, a beam above.
  fill(0, 1, 1, 0, 1, 3, t.counter);
  fill(0, 1, 5, 0, 1, 7, t.counter);
  fill(0, 4, 1, 0, 4, end - 1, t.planks);
  yield;
  // Stepped roof with an overhang, and a striped awning over the street.
  fill(-1, 5, -1, last + 1, 5, end + 1, t.slab, BOTTOM);
  fill(1, 5, 0, last - 1, 5, end, t.planks);
  fill(2, 6, 0, last - 2, 6, end, t.slab, BOTTOM);
  fill(3, 6, 1, last - 3, 6, end - 1, t.planks);
  fill(3, 7, 1, last - 3, 7, end - 1, t.slab, BOTTOM);
  for (let v = 0; v <= end; v++) set(-1, 4, v, t.awning[v % 2]);
  // Inside: a lantern, the trade's workstations along the back wall.
  set(3, 4, 4, "minecraft:lantern", { hanging: true });
  t.decor.forEach((stack, i) => {
    const v = 1 + i + (i >= 3 ? 1 : 0); // leave the middle (v 4) for the window post
    stack.forEach((id, h) => set(last - 1, 1 + h, v, id));
  });
  b.sign(f.x(0), 2, f.z(6), `§l${t.sign}§r\n${t.sub}`, side > 0 ? "west" : "east");
  yield;
}

function* plaza(b) {
  const { z1, z2, half } = PLAZA;
  b.fill(-half, 0, z1, half, 0, z2, "minecraft:polished_andesite");
  b.fill(-half + 1, 0, z1 - 1, half - 1, 0, z2 + 1, "minecraft:stone_bricks");
  b.fill(-half + 2, 0, z1 - 2, half - 2, 0, z2 + 2, "minecraft:polished_andesite");
  yield;
  // Fountain: a walled basin, a pillar with a lantern on top.
  const cz = Math.round((z1 + z2) / 2);
  b.fill(-3, 0, cz + 3, 3, 0, cz - 3, "minecraft:stone_bricks");
  b.fill(-3, 1, cz + 3, 3, 1, cz - 3, "minecraft:stone_brick_wall");
  b.fill(-2, 1, cz + 2, 2, 1, cz - 2, "minecraft:water");
  b.fill(0, 1, cz, 0, 3, cz, "minecraft:chiseled_stone_bricks");
  b.set(0, 4, cz, "minecraft:lantern", { hanging: false });
  // Planters and lamp posts at the corners, a bell at the head.
  for (const x of [-half + 2, half - 2]) {
    for (const z of [z1 - 2, z2 + 2]) {
      b.set(x, 0, z, "minecraft:moss_block");
      b.set(x, 1, z, ["minecraft:flowering_azalea", "minecraft:azalea"]);
    }
    for (const z of [z1 - 5, z2 + 5]) {
      b.fill(x, 1, z, x, 3, z, FENCE);
      b.set(x, 4, z, "minecraft:lantern", { hanging: false });
    }
  }
  b.set(0, 1, z2 + 1, "minecraft:bell");
  b.sign(2, 1, z2 + 1, "§lThe Plaza§r\nMarket Street", "south");
  yield;
}

// ---------------------------------------------------------------- loading

/** Runs `fn` once the market's chunks are loaded, holding them with a
 * ticking area meanwhile. */
function whileLoaded(b, label, fn) {
  const dim = b.dim;
  const corners = [
    b.at(-SITE.half, 0, 0), b.at(SITE.half, 0, 0),
    b.at(-SITE.half, 0, SITE.z2), b.at(SITE.half, 0, SITE.z2),
    b.at(0, 0, Math.round(SITE.z2 / 2)),
  ];
  const loaded = () => corners.every((c) => dim.isChunkLoaded(c));
  const mid = b.at(0, 0, Math.round(SITE.z2 / 2));
  let added = false;
  if (!loaded()) {
    dim.runCommand(`tickingarea remove ${AREA}`);
    system.runTimeout(() => dim.runCommand(`tickingarea add circle ${mid.x} 0 ${mid.z} 4 ${AREA} true`), 2);
    added = true;
  }
  const started = system.currentTick;
  const wait = system.runInterval(() => {
    if (!loaded()) {
      if (system.currentTick - started > 20 * 60) {
        system.clearRun(wait);
        if (added) dim.runCommand(`tickingarea remove ${AREA}`);
        emit(`${label}_done`, { ok: false, error: "Market Street's chunks didn't load" });
      }
      return;
    }
    system.clearRun(wait);
    fn(() => {
      // Let the last changes save before letting the chunks go.
      if (added) system.runTimeout(() => dim.runCommand(`tickingarea remove ${AREA}`), 100);
    });
  }, 10);
}

// The Pawnbroker keeps a stand on the plaza, between the street and the
// fountain: a counter of barrels and a sign. Placed with the vendors, so a
// market built before the Pawnbroker existed gets the stand too.
const PAWN = { x: 0, z: PLAZA.z1 - 2 };

function pawnStand(b) {
  for (const x of [-2, 2]) b.set(PAWN.x + x, 1, PAWN.z - 1, "minecraft:barrel", { facing_direction: 1 });
  b.set(PAWN.x + 2, 2, PAWN.z - 1, "minecraft:lantern", { hanging: false });
  b.sign(PAWN.x - 2, 2, PAWN.z - 1, "§lPawnbroker§r\nbuys tower loot\n§7for coins", "south");
}

function placeVendors(b) {
  for (const [kind, side, slot] of STALLS) spawnVendor(vendorSpot(b, side, slot), kind);
  pawnStand(b);
  const at = b.at(PAWN.x, 1, PAWN.z - 1);
  spawnVendor({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, "pawnbroker");
}

/** Puts every vendor back at their counter. */
export function respawnMarketVendors() {
  const b = depotBuilder();
  whileLoaded(b, "vendors", (release) => {
    try {
      placeVendors(b);
      emit("vendors_done", { ok: true, where: "market" });
    } catch (e) {
      emit("vendors_done", { ok: false, error: String(e) });
    }
    release();
  });
  return { pending: true, where: "market" };
}

/** Builds (or rebuilds) Market Street behind the depot. Async: emits
 * market_done when finished. */
export function buildMarket() {
  const b = depotBuilder();
  whileLoaded(b, "market", (release) => {
    system.runJob(
      (function* () {
        try {
          yield* clearSite(b);
          yield* street(b);
          for (const [kind, side, slot] of STALLS) yield* stall(b, kind, side, slot);
          yield* plaza(b);
          placeVendors(b);
          world.setDynamicProperty(MARKET_PROP, true);
          emit("market_done", { ok: true, shops: STALLS.length, errors: [...b.errors] });
        } catch (e) {
          emit("market_done", { ok: false, error: String(e), errors: [...b.errors] });
        }
        release();
      })()
    );
  });
  const entrance = b.at(0, 1, STREET_START);
  return { pending: true, entrance, plaza: b.at(0, 1, Math.round((PLAZA.z1 + PLAZA.z2) / 2)) };
}
