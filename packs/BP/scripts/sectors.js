// Wall-breakers: spreading an attack around the defences. Left alone, every
// mob paths to the core the cheapest way and the whole wave piles onto one
// spot of the wall. Instead a share of the melee ground attackers
// (`breaker_share`) is sent to one of eight sectors around the core, within
// ±90° of where it came in: it paths to that sector's waypoint (an
// invisible dm:waypoint just outside the outermost wall in that direction),
// then is switched back to targeting the core and digs in from there.
//
// Waypoints are placed by scanning out from the core along each sector's
// direction for the outermost sharp rise (a wall, not a hill), refreshed
// every REFRESH_TICKS while there's a core.

import { system } from "@minecraft/server";
import { getConfig } from "./breach.js";
import { coreCenter, coreLocation } from "./core.js";
import { attackers } from "./spawner.js";
import { overworld } from "./util.js";

export const SECTORS = 8;
const SCAN_FROM = 2; // blocks from the core
const SCAN_MAX = 30; // defences sit near the core; cliffs further out are terrain
const WALL_STEP = 3; // a rise this sharp (blocks) is a wall, not a slope
const MARKER_GAP = 2; // waypoint this far outside the outer face
const DEFAULT_RING = 10; // nothing built in that direction
const REFRESH_TICKS = 200;
const CHECK_TICKS = 10;
const ARRIVE = 3; // blocks from the waypoint (flat)
const BREAKER_TIMEOUT = 60 * 20; // ticks; then it goes for the core regardless
// Melee walkers dig or blast; archers and flyers keep their own ways.
const BREAKER_TYPES = new Set(["dm:zombie", "dm:swarmer", "dm:digger", "dm:sapper", "dm:warlord", "dm:demolisher"]);

let ring = []; // sector -> {x, y, z, r}

function angleOf(n) {
  return (n * 2 * Math.PI) / SECTORS;
}

/** Ground height at (x, z): the topmost block, looking through trees. */
function surface(dim, x, z) {
  let block = dim.getTopmostBlock({ x, z });
  for (let i = 0; block && i < 24; i++) {
    const id = block.typeId;
    if (!(id.includes("leaves") || id.includes("log") || id.includes("vine") || block.isAir)) break;
    block = block.below();
  }
  return block ? block.location.y : undefined;
}

/** The outer face of the defences in sector `n`'s direction: walking in
 * from SCAN_MAX, the outermost rise of WALL_STEP or more blocks (a wall or
 * a fortification; hills rise gently and don't count). The waypoint goes
 * MARKER_GAP blocks outside it, on the ground. */
function scanSector(dim, core, n) {
  const ux = Math.cos(angleOf(n));
  const uz = Math.sin(angleOf(n));
  const heights = [];
  for (let r = SCAN_FROM; r <= SCAN_MAX; r++) {
    try {
      heights[r] = surface(dim, Math.floor(core.x + ux * r), Math.floor(core.z + uz * r));
    } catch {
      heights[r] = undefined; // not loaded
    }
  }
  let face = -1;
  for (let r = SCAN_MAX; r > SCAN_FROM; r--) {
    const outside = heights[r];
    const inside = heights[r - 1];
    if (outside !== undefined && inside !== undefined && inside - outside >= WALL_STEP) {
      face = r - 1;
      break;
    }
  }
  const r = face >= 0 ? face + MARKER_GAP : DEFAULT_RING;
  const x = core.x + ux * r;
  const z = core.z + uz * r;
  const ground = heights[Math.min(r, SCAN_MAX)];
  return { x, y: (ground ?? Math.floor(core.y) - 1) + 1, z, r };
}

/** Recomputes the ring and moves (or makes) the waypoints. */
export function refreshSectors() {
  const loc = coreLocation();
  if (!loc) return [];
  const dim = overworld();
  const core = { ...coreCenter(loc), y: loc.y + 1 };
  ring = [];
  for (let n = 0; n < SECTORS; n++) ring.push(scanSector(dim, core, n));
  const existing = new Map();
  for (const marker of dim.getEntities({ type: "dm:waypoint" })) {
    const tag = marker.getTags().find((t) => t.startsWith("sector_"));
    if (!tag || existing.has(tag)) marker.remove();
    else existing.set(tag, marker);
  }
  ring.forEach((spot, n) => {
    const tag = `sector_${n}`;
    const at = { x: spot.x, y: spot.y, z: spot.z };
    try {
      const marker = existing.get(tag);
      if (marker) marker.teleport(at);
      else dim.spawnEntity("dm:waypoint", at).addTag(tag);
    } catch {
      // that spot isn't loaded
    }
  });
  return ring;
}

/** Maybe makes a freshly spawned attacker a wall-breaker. */
export function assignBreaker(mob) {
  if (!BREAKER_TYPES.has(mob.typeId)) return;
  const share = getConfig().breaker_share ?? 0.4;
  if (share <= 0 || Math.random() >= share) return;
  const loc = coreLocation();
  if (!loc) return;
  if (!ring.length) refreshSectors();
  const core = coreCenter(loc);
  const p = mob.location;
  const angle = Math.atan2(p.z - core.z, p.x - core.x);
  const home = Math.round(angle / angleOf(1));
  const n = (((home + Math.floor(Math.random() * 5) - 2) % SECTORS) + SECTORS) % SECTORS; // within ±2 sectors (±90°)
  mob.triggerEvent(`dm:tgt_sector_${n}`);
  mob.setDynamicProperty("dtc:breaker", n);
  mob.setDynamicProperty("dtc:breaker_at", system.currentTick);
}

/** Back to the core: at its waypoint, or after BREAKER_TIMEOUT. */
function release(mob) {
  const targeting = mob.getDynamicProperty("dtc:targeting");
  mob.triggerEvent(`dm:tgt_${typeof targeting === "string" ? targeting : "prioritized"}`);
  mob.setDynamicProperty("dtc:breaker", undefined);
}

function check() {
  if (!coreLocation()) return;
  const now = system.currentTick;
  for (const mob of attackers()) {
    const n = mob.getDynamicProperty("dtc:breaker");
    if (typeof n !== "number") continue;
    try {
      const spot = ring[n];
      const since = mob.getDynamicProperty("dtc:breaker_at");
      const late = typeof since === "number" && now - since > BREAKER_TIMEOUT;
      const p = mob.location;
      if (!spot || late || Math.hypot(p.x - spot.x, p.z - spot.z) < ARRIVE) release(mob);
    } catch {
      // gone
    }
  }
}

/** For the DM: where the waypoints are and how many breakers are out. */
export function sectorStatus() {
  const breakers = attackers().filter((m) => typeof m.getDynamicProperty("dtc:breaker") === "number").length;
  return { ring: ring.map(({ x, y, z, r }) => ({ x: Math.round(x), y, z: Math.round(z), r })), breakers };
}

export function startSectors() {
  system.runTimeout(refreshSectors, 40);
  system.runInterval(() => {
    try {
      refreshSectors();
    } catch {
      // the core's area is unloaded
    }
  }, REFRESH_TICKS);
  system.runInterval(check, CHECK_TICKS);
}
