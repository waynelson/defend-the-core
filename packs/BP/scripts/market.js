// The Mall: the vendors' building behind the supply depot (on the side away
// from the core). A modern two-storey hall: glass front, a double-height
// atrium with a skylight, twelve shop units on the ground floor (six each
// side, glass storefronts with a coloured band and a floating name), and
// twelve empty rooms upstairs off glass-railed balconies, reached by a
// staircase at the back (kept for server controls and player settings
// later). The atrium holds the public leaderboards (boards.js).
//
// Laid out in the depot's frame (local +z points at the core, so the mall
// runs toward -z). Building it far from players needs its chunks loaded:
// a temporary ticking area covers it while it builds. (Exported names stay
// "market" for the rest of the add-on: Market Street was its first form.)

import { GameMode, system, world } from "@minecraft/server";
import { depotBuilder } from "./depot.js";
import { DIFFICULTIES, registerControls, selectedDifficulty } from "./controls.js";
import { spawnVendor } from "./shop.js";
import { emit } from "./util.js";

const MARKET_PROP = "dtc:market";
const AREA = "dtc_market";

// Local geometry. Outer shell x = ±HALF, z FRONT..BACK; ground floor y 0,
// upper floor y UPPER, roof y ROOF.
const HALF = 14;
const ATRIUM = 3; // open (double height) for x in -3..3
const FRONT = -9;
const BACK = -41;
const UPPER = 6;
const ROOF = 12;
const STOREFRONT = 4; // ground-floor shop glass at x = ±4
const ROOMFRONT = 7; // upper-floor room glass at x = ±7
const ACCENT = 13; // each shop's feature back wall at x = ±13
const DIVIDERS = [-10, -15, -20, -25, -30, -35, -40]; // walls between units
// The whole area cleared before building: the mall plus where Market Street
// used to stand.
const CLEAR = { half: 14, z1: -8, z2: -72 };

const WHITE = "minecraft:white_concrete";
const GLASS = "minecraft:glass";
const PANE = "minecraft:glass_pane";
const LIGHT = ["minecraft:sea_lantern", "minecraft:glowstone"];

// [kind, side (-1 west / +1 east), unit 0..5 from the entrance]; null kind
// = an empty unit ("coming soon").
/** @type {[string | null, number, number][]} */
const UNITS = [
  ["engineer", -1, 0], ["ranged", 1, 0],
  ["mason", -1, 1], ["melee", 1, 1],
  ["provisioner", -1, 2], ["armor", 1, 2],
  ["pawnbroker", -1, 3], ["health", 1, 3],
  [null, -1, 4], ["regen", 1, 4],
  [null, -1, 5], [null, 1, 5],
];

const THEMES = {
  engineer: {
    name: "ENGINEER", sub: "turrets, traps & repairs", band: "minecraft:orange_concrete",
    floor: "minecraft:smooth_stone", accent: "minecraft:deepslate_tiles",
    decor: [["minecraft:dispenser"], ["minecraft:redstone_block", "minecraft:redstone_lamp"], ["minecraft:observer"], ["minecraft:piston"]],
  },
  mason: {
    name: "MASON", sub: "blocks by the stack", band: "minecraft:light_gray_concrete",
    floor: "minecraft:polished_andesite", accent: "minecraft:stone_bricks",
    decor: [["minecraft:stonecutter_block"], ["minecraft:polished_granite"], ["minecraft:mossy_stone_bricks"], ["minecraft:polished_diorite"]],
  },
  provisioner: {
    name: "PROVISIONER", sub: "tools, food & supplies", band: "minecraft:green_concrete",
    floor: "minecraft:spruce_planks", accent: "minecraft:oak_planks",
    decor: [["minecraft:barrel", "minecraft:barrel"], ["minecraft:smoker"], ["minecraft:composter"], ["minecraft:hay_block"]],
  },
  pawnbroker: {
    name: "PAWNBROKER", sub: "buys tower loot", band: "minecraft:yellow_concrete",
    floor: "minecraft:dark_oak_planks", accent: "minecraft:gold_block",
    decor: [["minecraft:chest"], ["minecraft:barrel", "minecraft:barrel"], ["minecraft:lectern"], ["minecraft:barrel"]],
  },
  ranged: {
    name: "BOWYER", sub: "ranged skill & bows", band: "minecraft:lime_concrete",
    floor: "minecraft:oak_planks", accent: "minecraft:birch_planks",
    decor: [["minecraft:target"], ["minecraft:fletching_table"], ["minecraft:hay_block", "minecraft:target"], ["minecraft:fletching_table"]],
  },
  melee: {
    name: "BLACKSMITH", sub: "melee skill & blades", band: "minecraft:red_concrete",
    floor: "minecraft:polished_blackstone", accent: "minecraft:polished_blackstone_bricks",
    decor: [["minecraft:anvil"], ["minecraft:blast_furnace"], ["minecraft:grindstone"], ["minecraft:smithing_table"]],
  },
  armor: {
    name: "ARMORER", sub: "armour skill & enchants", band: "minecraft:blue_concrete",
    floor: "minecraft:spruce_planks", accent: "minecraft:brick_block",
    decor: [["minecraft:smithing_table"], ["minecraft:anvil"], ["minecraft:iron_block"], ["minecraft:blast_furnace"]],
  },
  health: {
    name: "HEALER", sub: "health skill & healing", band: "minecraft:pink_concrete",
    floor: "minecraft:birch_planks", accent: "minecraft:smooth_quartz",
    decor: [["minecraft:cauldron"], ["minecraft:moss_block", "minecraft:flowering_azalea"], ["minecraft:brewing_stand"], ["minecraft:honey_block"]],
  },
  regen: {
    name: "ALCHEMIST", sub: "regen skill & potions", band: "minecraft:purple_concrete",
    floor: "minecraft:mangrove_planks", accent: "minecraft:mud_bricks",
    decor: [["minecraft:brewing_stand"], ["minecraft:bookshelf", "minecraft:bookshelf"], ["minecraft:cauldron"], ["minecraft:amethyst_block"]],
  },
  soon: {
    name: "COMING SOON", sub: "", band: "minecraft:gray_concrete",
    floor: "minecraft:light_gray_concrete", accent: WHITE, decor: [],
  },
};

export function marketBuilt() {
  return world.getDynamicProperty(MARKET_PROP) === true;
}

/** The mall's footprint in world x/z (with a margin), or undefined. */
export function marketBounds(margin = 2) {
  if (!marketBuilt()) return undefined;
  let b;
  try {
    b = depotBuilder();
  } catch {
    return undefined;
  }
  const corners = [b.at(-HALF, 0, -4), b.at(HALF, 0, -4), b.at(-HALF, 0, BACK), b.at(HALF, 0, BACK)];
  return {
    x1: Math.min(...corners.map((c) => c.x)) - margin, x2: Math.max(...corners.map((c) => c.x)) + margin,
    z1: Math.min(...corners.map((c) => c.z)) - margin, z2: Math.max(...corners.map((c) => c.z)) + margin,
  };
}

// The mall is protected: players (except in creative) can't break its
// blocks, explosions spare them and attackers don't dig into them. The box
// (world coordinates, floor to roof) is cached and refreshed every few
// seconds, since breach code asks for every block it touches.
let box;
let boxAt = -Infinity;

function mallBox() {
  if (system.currentTick - boxAt < 100) return box;
  boxAt = system.currentTick;
  const flat = marketBounds(0);
  if (!flat) return (box = undefined);
  try {
    const y = depotBuilder().center.y;
    box = { ...flat, y1: y - 1, y2: y + ROOF };
  } catch {
    box = undefined;
  }
  return box;
}

/** Whether a block position is part of the mall. */
export function inMall(loc) {
  const b = mallBox();
  return Boolean(b) && loc.x >= b.x1 && loc.x <= b.x2 && loc.z >= b.z1 && loc.z <= b.z2 && loc.y >= b.y1 && loc.y <= b.y2;
}

export function protectMall() {
  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    if (!inMall(event.block.location)) return;
    if (event.player.getGameMode() === GameMode.Creative) return;
    event.cancel = true;
    const player = event.player;
    system.run(() => player.sendMessage("§cThe mall is protected."));
  });
}

/** Unit `i`'s span along z: [front wall, back wall] and its door blocks. */
function unitZ(i) {
  const front = DIVIDERS[i];
  const back = DIVIDERS[i + 1];
  return { front, back, inner1: front - 1, inner2: back + 1, door: [front - 2, front - 3] };
}

/** Bedrock stairs' weirdo_direction for a world direction (ascending that way). */
const STAIR_DIR = { east: 0, west: 1, south: 2, north: 3 };

// ---------------------------------------------------------------- parts

const FLUIDS = ["minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"];

/** Keeps water out: fluids in a band around the site turn to dirt, and any
 * left inside (or flowing in while it was open) is drained. A site below
 * the local water level otherwise floods through the doors (seen on dev). */
function* waterproof(b) {
  const { half, z2 } = CLEAR;
  const out = half + 3;
  for (let z = -2; z >= z2 - 3; z -= 16) {
    const zEnd = Math.max(z2 - 3, z - 15);
    b.replace(-out, -3, z, -half - 1, 20, zEnd, "minecraft:dirt", FLUIDS);
    b.replace(half + 1, -3, z, out, 20, zEnd, "minecraft:dirt", FLUIDS);
    yield;
  }
  b.replace(-out, -3, z2 - 1, out, 20, z2 - 3, "minecraft:dirt", FLUIDS);
  // In front, either side of the depot.
  for (const side of [-1, 1]) b.replace(side * 8, -3, -2, side * out, 20, -4, "minecraft:dirt", FLUIDS);
  yield;
  for (let z = -4; z >= z2; z -= 8) {
    b.replace(-half, -3, z, half, 20, Math.max(z2, z - 7), "minecraft:air", FLUIDS);
    yield;
  }
}

function* clearSite(b) {
  for (let z = CLEAR.z1; z >= CLEAR.z2; z -= 8) {
    const z2 = Math.max(CLEAR.z2, z - 7);
    b.fill(-CLEAR.half, -6, z, CLEAR.half, -1, z2, "minecraft:dirt");
    b.fill(-CLEAR.half, 1, z, CLEAR.half, 20, z2, "minecraft:air");
    b.fill(-CLEAR.half, 0, z, CLEAR.half, 0, z2, "minecraft:grass_block");
    yield;
  }
}

function* shell(b) {
  // Through the back of the depot to the mall's doors.
  b.fill(-1, 1, -5, 1, 4, -8, "minecraft:air");
  b.fill(-1, 0, -5, 1, 0, -8, "minecraft:smooth_stone");
  // Floors: polished atrium with grey edging, white upper floor.
  b.fill(-HALF, 0, FRONT, HALF, 0, BACK, "minecraft:polished_diorite");
  b.fill(-ATRIUM, 0, FRONT + 1, -ATRIUM, 0, BACK + 1, "minecraft:light_gray_concrete");
  b.fill(ATRIUM, 0, FRONT + 1, ATRIUM, 0, BACK + 1, "minecraft:light_gray_concrete");
  yield;
  // Outer walls (white), a glass front between white frames.
  b.fill(-HALF, 1, BACK, HALF, ROOF - 1, BACK, WHITE);
  b.fill(-HALF, 1, FRONT, -HALF, ROOF - 1, BACK, WHITE);
  b.fill(HALF, 1, FRONT, HALF, ROOF - 1, BACK, WHITE);
  b.fill(-HALF + 1, 1, FRONT, HALF - 1, ROOF - 1, FRONT, GLASS);
  for (const x of [-STOREFRONT, STOREFRONT, -ROOMFRONT - 3, ROOMFRONT + 3]) b.fill(x, 1, FRONT, x, ROOF - 1, FRONT, WHITE);
  b.fill(-HALF, UPPER, FRONT, HALF, UPPER, FRONT, WHITE);
  // Side windows along the upper floor.
  for (const x of [-HALF, HALF]) {
    for (let i = 0; i < 6; i++) {
      const u = unitZ(i);
      b.fill(x, UPPER + 2, u.inner1 - 1, x, UPPER + 4, u.inner2 + 1, PANE);
    }
  }
  // The entrance.
  b.fill(-2, 1, FRONT, 2, 3, FRONT, "minecraft:air");
  yield;
  // Roof with a skylight over the atrium; lights in the roof.
  b.fill(-HALF, ROOF, FRONT, HALF, ROOF, BACK, WHITE);
  b.fill(-ATRIUM, ROOF, FRONT + 1, ATRIUM, ROOF, BACK - 1, GLASS);
  for (let i = 0; i < 6; i++) {
    const z = unitZ(i).door[0];
    for (const x of [-10, 10, -5, 5]) b.set(x, ROOF, z, LIGHT);
  }
  yield;
}

function* upperFloor(b) {
  // Floor over the shops and a bridge across the back of the atrium.
  for (const side of [-1, 1]) b.fill(side * STOREFRONT, UPPER, FRONT + 1, side * (HALF - 1), UPPER, BACK + 1, "minecraft:smooth_quartz");
  b.fill(-ATRIUM, UPPER, -38, ATRIUM, UPPER, BACK + 1, "minecraft:smooth_quartz");
  // Glass railings along the balconies and the bridge (a gap for the stairs).
  for (const side of [-1, 1]) b.fill(side * STOREFRONT, UPPER + 1, FRONT + 1, side * STOREFRONT, UPPER + 1, -38, PANE);
  b.fill(-ATRIUM, UPPER + 1, -38, -2, UPPER + 1, -38, PANE);
  b.fill(2, UPPER + 1, -38, ATRIUM, UPPER + 1, -38, PANE);
  yield;
  // Twelve rooms: glass fronts with a door, white walls between.
  for (const side of [-1, 1]) {
    b.fill(side * ROOMFRONT, UPPER + 1, FRONT + 1, side * ROOMFRONT, ROOF - 1, BACK + 1, PANE);
    for (const z of DIVIDERS) b.fill(side * ROOMFRONT, UPPER + 1, z, side * (HALF - 1), ROOF - 1, z, WHITE);
    for (let i = 0; i < 6; i++) {
      const u = unitZ(i);
      b.fill(side * ROOMFRONT, UPPER + 1, u.door[0], side * ROOMFRONT, UPPER + 2, u.door[1], "minecraft:air");
    }
  }
  yield;
  // The staircase up the back of the atrium (six steps to the bridge).
  const facing = STAIR_DIR[b.dir("north")];
  for (let k = 1; k <= 6; k++) {
    const z = -31 - k;
    if (k > 1) b.fill(-1, 1, z, 1, k - 1, z, "minecraft:smooth_quartz");
    b.fill(-1, k, z, 1, k, z, "minecraft:quartz_stairs", { weirdo_direction: facing, upside_down_bit: false });
  }
  yield;
}

function* unit(b, kind, side, i) {
  const t = THEMES[kind ?? "soon"];
  const u = unitZ(i);
  const x = (n) => side * n;
  // Floor, walls between units, the feature back wall.
  b.fill(x(STOREFRONT + 1), 0, u.inner1, x(ACCENT), 0, u.inner2, t.floor);
  b.fill(x(STOREFRONT), 1, u.front, x(HALF - 1), UPPER - 1, u.front, WHITE);
  b.fill(x(STOREFRONT), 1, u.back, x(HALF - 1), UPPER - 1, u.back, WHITE);
  b.fill(x(ACCENT), 1, u.inner1, x(ACCENT), UPPER - 1, u.inner2, t.accent);
  // Storefront: glass with a door, the shop's colour band above.
  b.fill(x(STOREFRONT), 1, u.inner1, x(STOREFRONT), UPPER - 2, u.inner2, PANE);
  b.fill(x(STOREFRONT), 1, u.door[0], x(STOREFRONT), 2, u.door[1], "minecraft:air");
  b.fill(x(STOREFRONT), UPPER - 1, u.inner1, x(STOREFRONT), UPPER - 1, u.inner2, t.band);
  // A light in the ceiling; the trade's workstations along the back wall.
  b.set(x(9), UPPER, u.door[0], LIGHT);
  t.decor.forEach((stack, n) => stack.forEach((id, h) => b.set(x(ACCENT - 1), 1 + h, u.inner1 - n, id)));
  yield;
}

function* atrium(b) {
  // Planters down the atrium, the leaderboard kiosks by the entrance.
  for (const z of [-20, -30]) {
    for (const x of [-ATRIUM + 1, ATRIUM - 1]) {
      b.set(x, 0, z, "minecraft:moss_block");
      b.set(x, 1, z, ["minecraft:flowering_azalea", "minecraft:azalea"]);
    }
  }
  for (const x of [-2, 2]) b.set(x, 1, BOARD_Z, "minecraft:polished_blackstone");
  yield;
}

// ---------------------------------------------------------------- controls

// The two upper rooms at the back (unit 5, by the top of the stairs) are
// control rooms: west the auto DM, east the world. Buttons and levers sit
// on the walls at chest height with a wall sign above each.
const CONTROL_Y = UPPER + 2;

function controlRooms(b) {
  const u = unitZ(5);
  const map = {};
  const register = (lx, y, lz, action) => {
    const at = b.at(lx, y, lz);
    map[`${at.x},${at.y},${at.z}`] = action;
  };
  const back = (side) => side * (HALF - 1); // x of a control on the back wall
  const row = [u.inner1, u.inner1 - 1, u.inner2 + 1, u.inner2]; // z along it
  // A red backing for the reset button.
  b.fill(9, CONTROL_Y - 1, u.inner2 - 1, 11, CONTROL_Y + 1, u.inner2 - 1, "minecraft:red_concrete");

  const buttons = [
    // [side, local x, local z, face, action, sign text]
    [-1, back(-1), row[0], "east", "auto_toggle", "§lAUTO DM\nstart / stop"],
    [-1, back(-1), row[1], "east", "pause_toggle", "§lPAUSE\nresume"],
    [-1, back(-1), row[2], "east", "next_wave", "§lNEXT WAVE\nnow"],
    [-1, back(-1), row[3], "east", "supply_drop", "§lSUPPLY\nDROP"],
    [1, back(1), row[0], "west", "fix_mall", "§lFIX MALL\n§7rebuilds it"],
    [1, back(1), row[1], "west", "restock", "§lRESTOCK\nDEPOT"],
    [1, back(1), row[2], "west", "respawn_vendors", "§lVENDORS\ncall back"],
    [1, back(1), row[3], "west", "raise_tower", "§lRAISE\nTOWER"],
    [1, 12, u.inner1, "north", "daytime", "§lDAYTIME\n§7clear skies"],
    [1, 10, u.inner2, "south", "reset_map", "§4§lRESET MAP\n§r§cpress twice"],
  ];
  for (const [, x, z, face, action, text] of buttons) {
    b.button(x, CONTROL_Y, z, face);
    b.wallSign(x, CONTROL_Y + 1, z, text, face);
    register(x, CONTROL_Y, z, action);
  }
  // Difficulty levers on the west room's front wall, facing in.
  const selected = selectedDifficulty();
  Object.keys(DIFFICULTIES).forEach((level, i) => {
    const x = -(9 + i);
    b.lever(x, CONTROL_Y, u.inner1, "north", level === selected);
    b.wallSign(x, CONTROL_Y + 1, u.inner1, `§lDIFFICULTY\n${DIFFICULTIES[level].label}`, "north");
    register(x, CONTROL_Y, u.inner1, `difficulty_${level}`);
  });
  registerControls(map);
}

// ---------------------------------------------------------------- labels

const BOARD_Z = -13;

/** Floating text: one dm:label per key, replaced on every placement. */
function placeLabels(b) {
  const dim = b.dim;
  for (const old of dim.getEntities({ type: "dm:label" })) {
    if (typeof old.getDynamicProperty("dtc:label") === "string") old.remove();
  }
  const put = (lx, y, lz, key, text) => {
    const at = b.at(lx, y, lz);
    const label = dim.spawnEntity("dm:label", { x: at.x + 0.5, y: at.y, z: at.z + 0.5 });
    label.setDynamicProperty("dtc:label", key);
    label.nameTag = text;
  };
  for (const [kind, side, i] of UNITS) {
    const t = THEMES[kind ?? "soon"];
    put(side * (STOREFRONT - 1), 3, unitZ(i).door[0], `shop_${side}_${i}`, `§l${kind ? "§b" : "§7"}${t.name}${t.sub ? `\n§r§7${t.sub}` : ""}`);
  }
  put(0, 4, FRONT + 1, "mall_title", "§l§bDEFEND THE CORE MALL\n§r§7shops on the ground floor");
  put(0, UPPER + 2, -40, "upper", "§l§bLEVEL 2\n§r§7control rooms at the back");
  put(-10, UPPER + 4, unitZ(5).door[0], "room_auto", "§l§6AUTO DM CONTROLS");
  put(10, UPPER + 4, unitZ(5).door[0], "room_world", "§l§cWORLD CONTROLS");
  put(-2, 2, BOARD_Z, "board_kills", "§c§lTOP KILLERS");
  put(2, 2, BOARD_Z, "board_earned", "§e§lTOP EARNERS");
}

// ---------------------------------------------------------------- loading

/** Runs `fn` once the mall's chunks are loaded, holding them with a
 * ticking area meanwhile. */
function whileLoaded(b, label, fn) {
  const dim = b.dim;
  const corners = [
    b.at(-CLEAR.half, 0, 0), b.at(CLEAR.half, 0, 0),
    b.at(-CLEAR.half, 0, CLEAR.z2), b.at(CLEAR.half, 0, CLEAR.z2),
    b.at(0, 0, Math.round(CLEAR.z2 / 2)),
  ];
  const loaded = () => corners.every((c) => dim.isChunkLoaded(c));
  const mid = b.at(0, 0, Math.round(CLEAR.z2 / 2));
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
        emit(`${label}_done`, { ok: false, error: "the mall's chunks didn't load" });
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

function placeVendors(b) {
  for (const [kind, side, i] of UNITS) {
    if (!kind) continue;
    const at = b.at(side * 9, 1, unitZ(i).door[0]);
    spawnVendor({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, kind);
  }
  placeLabels(b);
  controlRooms(b);
}

/** Puts every vendor (and the floating signs and boards) back. */
export function respawnMarketVendors() {
  const b = depotBuilder();
  whileLoaded(b, "vendors", (release) => {
    try {
      placeVendors(b);
      emit("vendors_done", { ok: true, where: "mall" });
    } catch (e) {
      emit("vendors_done", { ok: false, error: String(e) });
    }
    release();
  });
  return { pending: true, where: "mall" };
}

/** Builds (or rebuilds) the mall behind the depot, clearing Market Street
 * if it stood there. Async: emits market_done when finished. */
export function buildMarket() {
  const b = depotBuilder();
  whileLoaded(b, "market", (release) => {
    system.runJob(
      (function* () {
        try {
          yield* waterproof(b);
          yield* clearSite(b);
          yield* shell(b);
          for (const [kind, side, i] of UNITS) yield* unit(b, kind, side, i);
          yield* upperFloor(b);
          yield* atrium(b);
          yield* waterproof(b);
          placeVendors(b);
          world.setDynamicProperty(MARKET_PROP, true);
          boxAt = -Infinity; // protect the new footprint at once
          emit("market_done", { ok: true, shops: UNITS.length, errors: [...b.errors] });
        } catch (e) {
          emit("market_done", { ok: false, error: String(e), errors: [...b.errors] });
        }
        release();
      })()
    );
  });
  return { pending: true, entrance: b.at(0, 1, FRONT), atrium: b.at(0, 1, -25) };
}
