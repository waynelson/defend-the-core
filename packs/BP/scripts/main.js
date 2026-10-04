// Defend the Core: command router and world events.
//
// The DM drives everything with `/scriptevent dm:<action> <json>` from the
// server console. Every message gets an `ack` or `nack` (matched by msg_id),
// and game events are reported as `[DM] {json}` lines in the server log. See
// README.md for the protocol.

import { system, world } from "@minecraft/server";
import { getConfig, setConfig, damagedBlocks, startBreach } from "./breach.js";
import { clearCore, coreEntity, coreHp, coreLocation, forgetCore, labelCore, placeCore } from "./core.js";
import { buildDepot, depotSitesLoaded, respawnVendors, restockDepot } from "./depot.js";
import { control, coreLost, gameStatus, hooks, resetGame, setPhase, startGame, waveBegin, waveCommit, waveGroup } from "./game.js";
import { bountyOwner, defenseList, dmMine, dmPlace, startDefenses } from "./defenses.js";
import { econ, grantCoins, payBounty, setEconomy, startEconomy } from "./economy.js";
import { playerList, startPlayers } from "./players.js";
import { grantProgress, killXp, progressionConfig, roundEnd, setProgression, startProgression } from "./progression.js";
import { autoStatus, setAuto, startAuto } from "./auto.js";
import { startLoadout } from "./loadout.js";
import { newGameForAll, startStats } from "./stats.js";
import { blockPrices } from "./mason.js";
import { raiseTower, removeTower, startTowers, towerStatus } from "./tower.js";
import { startRain } from "./rewards.js";
import { SHOP, priceOf, startShop } from "./shop.js";
import { MOBS, MODULES, TARGETING } from "./roster.js";
import { attackers, spawnCenter, spawnOne, spawnPoints, validateSpawn } from "./spawner.js";
import { emit, overworld, pos, round, store } from "./util.js";

export const PROTOCOL = 1;

function ack(msgId, data = {}) {
  emit("ack", { msg_id: msgId, ...data });
}

function nack(msgId, error) {
  emit("nack", { msg_id: msgId, error: String(error) });
}

// ---------------------------------------------------------------- probe (dev)

let probe = { on: false, every: 20, handle: undefined };
const lastSample = new Map();

function sampleAttackers() {
  const loc = coreLocation();
  const seen = new Set();
  for (const mob of attackers()) {
    seen.add(mob.id);
    const p = mob.location;
    const dist = loc ? Math.hypot(p.x - loc.x - 0.5, p.z - loc.z - 0.5) : undefined;
    const prev = lastSample.get(mob.id);
    lastSample.set(mob.id, { x: p.x, z: p.z, dist });
    emit("probe", {
      id: mob.id,
      mob: mob.typeId,
      at: pos(p),
      dist: dist === undefined ? undefined : round(dist),
      moved: prev ? round(Math.hypot(p.x - prev.x, p.z - prev.z)) : undefined,
      hp: mob.getComponent("minecraft:health")?.currentValue,
    });
  }
  for (const id of lastSample.keys()) if (!seen.has(id)) lastSample.delete(id);
}

// ---------------------------------------------------------------- commands

const handlers = {
  ping() {
    return { pong: true, protocol: PROTOCOL };
  },
  status() {
    return {
      protocol: PROTOCOL,
      core: coreLocation() ?? null,
      core_hp: coreHp() ?? null,
      attackers: attackers().length,
      damaged_blocks: damagedBlocks(),
      config: getConfig(),
      points: spawnPoints(),
      auto: autoStatus(),
      tower: towerStatus(),
      ...gameStatus(),
    };
  },
  players() {
    return { players: playerList() };
  },
  // Economy: {wave_base, wave_step, bounty_mult, shop_open, turret_limit,
  // mine_limit, prices: {id: price|null}} changes settings; {} reads them.
  economy(msg) {
    const { msg_id: _id, v: _v, ...changes } = msg;
    const config = Object.keys(changes).length ? setEconomy(changes) : econ();
    return {
      ...config,
      shop: SHOP.map((s) => ({ id: s.id, label: s.label, price: priceOf(s, config) })),
      blocks: blockPrices(config),
    };
  },
  // Grant or take coins: {player, delta} or {all: true, delta}.
  coins(msg) {
    return grantCoins(msg);
  },
  // Put the Quartermaster, the Mason and the skill vendors back in the depot.
  vendor() {
    return respawnVendors();
  },
  defenses() {
    return defenseList();
  },
  // DM gift: {type: arrow|flak|frost, x, y, z, owner?}
  place_turret(msg) {
    if (![msg.x, msg.y, msg.z].every(Number.isInteger)) throw new Error("x, y, z must be integers");
    return dmPlace(msg);
  },
  // Auto DM: {on?, prep_s, intermission_s, waves, start, step, max, flyers,
  // rewards, restock_every, wave_timeout_s}; {} reads its state.
  auto(msg) {
    const { msg_id: _id, v: _v, ...changes } = msg;
    return Object.keys(changes).length ? setAuto(changes) : autoStatus();
  },
  // Levels: {kill_xp_mult, round_xp_base, round_xp_step, sp_per_level}; {} reads.
  progression(msg) {
    const { msg_id: _id, v: _v, ...changes } = msg;
    return Object.keys(changes).length ? setProgression(changes) : progressionConfig();
  },
  // DM grants: {player|all, xp?, sp?, level?}
  progress(msg) {
    return grantProgress(msg);
  },
  // A new game: wave count back to zero and every player starts afresh
  // (starting coins, level 1 skills, a level-1 kit, inventories cleared).
  new_game() {
    resetGame();
    return gameStatus();
  },
  // Towers: {floors?, difficulty?} raises one near the spawn (replacing the
  // last); tower_remove takes it down.
  tower(msg) {
    return raiseTower(msg);
  },
  tower_remove() {
    return removeTower();
  },
  // DM: lay a mine {type: blast|frost, x, y, z, owner?}
  place_mine(msg) {
    if (![msg.x, msg.y, msg.z].every(Number.isInteger)) throw new Error("x, y, z must be integers");
    return dmMine(msg);
  },
  // Reward: items rain around the core. {count?, radius?, duration_s?, quality?: 1..3}
  rain(msg) {
    return startRain(msg);
  },
  // The roster, modules and ranges, for the plugin's validator.
  roster() {
    return { protocol: PROTOCOL, mobs: MOBS, modules: MODULES, targeting: TARGETING };
  },

  core_set(msg) {
    const { x, z } = msg;
    if (![x, z].every(Number.isInteger)) throw new Error("x and z must be integers");
    // Without y, the core goes on the surface block at x, z.
    const y = msg.y ?? overworld().getTopmostBlock({ x, z })?.location.y;
    if (!Number.isInteger(y)) throw new Error(`no ground at ${x},${z} (chunk not loaded?)`);
    if (msg.setblock) overworld().getBlock({ x, y, z })?.setType("minecraft:beacon");
    placeCore({ x, y, z }, Boolean(msg.inside));
    return {};
  },
  core(msg) {
    const core = coreEntity();
    if (!core) throw new Error("no core entity");
    const health = core.getComponent("minecraft:health");
    if (msg.hp === "max") health.resetToMaxValue();
    else if (typeof msg.hp === "number" && msg.hp > 0) health.setCurrentValue(Math.min(msg.hp, health.effectiveMax));
    else throw new Error('hp must be a positive number or "max"');
    labelCore(core);
    return coreHp(core);
  },
  core_clear() {
    clearCore();
    return {};
  },
  tickingarea(msg) {
    const loc = coreLocation();
    if (!loc) throw new Error("no core set");
    const radius = Math.min(msg.radius ?? 4, 4); // chunks; 4 is the engine max
    overworld().runCommand(`tickingarea remove dtc_core`);
    system.runTimeout(() => {
      overworld().runCommand(`tickingarea add circle ${loc.x} 0 ${loc.z} ${radius} dtc_core true`);
    }, 2);
    return { radius_chunks: radius };
  },

  // Named spawn points: {points: {north: {x, z}, ...}} replaces the set.
  points(msg) {
    const points = msg.points ?? {};
    for (const [name, p] of Object.entries(points)) {
      if (!/^[a-z0-9_-]{1,24}$/.test(name)) throw new Error(`bad point name ${name}`);
      if (!Number.isInteger(p?.x) || !Number.isInteger(p?.z)) throw new Error(`point ${name} needs integer x, z`);
    }
    if (Object.keys(points).length > 16) throw new Error("at most 16 points");
    store("dtc:points", points);
    return { points };
  },
  // Ad-hoc spawn outside a wave (testing): {mob, count, bearing|point|x/z, dist, modules, targeting}.
  spawn(msg) {
    const modules = validateSpawn(msg);
    const count = Math.min(Math.max(1, msg.count ?? 1), 50);
    const center = spawnCenter(msg);
    let spawned = 0;
    for (let i = 0; i < count; i++) if (spawnOne(msg, center, modules)) spawned++;
    if (!spawned) throw new Error(`spawn point ${center.x},${center.z} is not loaded`);
    return { mob: msg.mob, spawned, at: center, modules };
  },
  targeting(msg) {
    if (!TARGETING.includes(msg.targeting)) throw new Error(`targeting must be one of ${TARGETING}`);
    const mobs = attackers();
    for (const mob of mobs) {
      mob.triggerEvent(`dm:tgt_${msg.targeting}`);
      mob.setDynamicProperty("dtc:targeting", msg.targeting);
    }
    return { changed: mobs.length };
  },

  // Game flow.
  phase(msg) {
    return setPhase(msg.phase, msg.duration_s);
  },
  wave_begin(msg) {
    return waveBegin(msg);
  },
  group(msg) {
    return waveGroup(msg);
  },
  wave_commit(msg) {
    return waveCommit(msg);
  },
  control(msg) {
    return control(msg.cmd);
  },
  config(msg) {
    return setConfig(msg);
  },
  kill_all() {
    return control("kill_all");
  },

  // Supply depot: {dist?: 50, x?, y?, z?, relocate?, path?: true}. Rebuilds
  // the existing depot in place; otherwise picks the flattest spot at `dist`
  // from the core unless x/z are given.
  depot(msg) {
    const loc = coreLocation();
    if (!loc) throw new Error("no core set");
    return buildDepot(loc, msg);
  },
  depot_restock() {
    return restockDepot();
  },
  // One-shot world setup for a fresh server: {x?, z?, dist?: 50}. Puts the
  // core on a beacon at x/z (default: world spawn), keeps the area loaded,
  // builds the depot and moves world spawn to the depot entrance. Chunks load
  // asynchronously, so the result arrives later as a `setup_done` line.
  setup(msg) {
    const spawn = world.getDefaultSpawnLocation();
    const x = msg.x ?? Math.floor(spawn.x);
    const z = msg.z ?? Math.floor(spawn.z);
    if (![x, z].every(Number.isInteger)) throw new Error("x and z must be integers");
    overworld().runCommand(`tickingarea remove dtc_core`);
    const started = system.currentTick;
    // The removed area's name stays taken until the next tick.
    system.runTimeout(() => {
      const added = overworld().runCommand(`tickingarea add circle ${x} 0 ${z} 4 dtc_core true`);
      if (!added.successCount) emit("setup_progress", { msg_id: msg.msg_id, error: "tickingarea add failed" });
    }, 2);
    const dist = msg.dist ?? 50;
    const poll = system.runInterval(() => {
      const timedOut = system.currentTick - started > 20 * 60;
      const coreLoaded = overworld().isChunkLoaded({ x, y: 0, z });
      if (!coreLoaded && timedOut) {
        system.clearRun(poll);
        emit("setup_done", { msg_id: msg.msg_id, ok: false, error: "chunks did not load in 60 s" });
      }
      // Wait for every depot candidate too; after 60 s, use whichever loaded.
      if (!coreLoaded || (!timedOut && !depotSitesLoaded({ x, z }, dist))) return;
      system.clearRun(poll);
      try {
        handlers.core_set({ x, z, setblock: true });
        const depot = buildDepot(coreLocation(), { dist, relocate: true });
        world.setDefaultSpawnLocation(depot.entrance);
        setPhase("setup", undefined, true);
        emit("setup_done", { msg_id: msg.msg_id, ok: true, core: coreLocation(), depot });
      } catch (err) {
        emit("setup_done", { msg_id: msg.msg_id, ok: false, error: String(err) });
      }
    }, 20);
    return { core_at: { x, z }, waiting_for_chunks: true };
  },

  probe(msg) {
    if (probe.handle !== undefined) system.clearRun(probe.handle);
    const on = msg.on !== false;
    const every = Math.max(5, msg.every ?? 20);
    probe = { on, every, handle: on ? system.runInterval(sampleAttackers, every) : undefined };
    return { on, every };
  },
};

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (!event.id.startsWith("dm:")) return;
  const action = event.id.slice(3);
  let msg = {};
  try {
    if (event.message.trim()) msg = JSON.parse(event.message);
  } catch (err) {
    return nack(undefined, `bad json: ${err}`);
  }
  if (msg.v !== undefined && msg.v !== PROTOCOL) {
    return nack(msg.msg_id, `protocol ${msg.v} not supported (this add-on speaks ${PROTOCOL})`);
  }
  const handler = handlers[action];
  if (!handler) return nack(msg.msg_id, `unknown action ${action}`);
  try {
    ack(msg.msg_id, { action, ...handler(msg) });
  } catch (err) {
    nack(msg.msg_id, `${action}: ${err instanceof Error ? err.message : err}`);
  }
});

// ---------------------------------------------------------------- world events

// The first beacon placed while no core exists becomes the core.
world.afterEvents.playerPlaceBlock.subscribe((event) => {
  if (event.block.typeId !== "minecraft:beacon" || coreLocation()) return;
  placeCore(event.block.location, false);
  emit("core_registered", { by: event.player.name, block: event.block.location });
});

world.afterEvents.entityHurt.subscribe(
  (event) => {
    const src = event.damageSource;
    labelCore(event.hurtEntity);
    emit("core_hp", {
      damage: round(event.damage),
      by: src.damagingEntity?.typeId ?? src.cause,
      ...coreHp(event.hurtEntity),
    });
  },
  { entityTypes: ["dm:core"] }
);

world.afterEvents.entityDie.subscribe(
  (event) => {
    const src = event.damageSource;
    if (event.deadEntity.typeId === "dm:core") {
      forgetCore();
      coreLost();
      emit("game_over", { result: "lost", by: src.damagingEntity?.typeId ?? src.cause });
    } else {
      emit("attacker_died", { mob: event.deadEntity.typeId, by: src.damagingEntity?.typeId ?? src.cause });
      const earner = bountyOwner(event.deadEntity, src.damagingEntity);
      payBounty(event.deadEntity.typeId, earner);
      killXp(event.deadEntity.typeId, earner);
    }
  },
  { entityTypes: ["dm:core", ...Object.keys(MOBS)] }
);

world.afterEvents.worldLoad.subscribe(() => {
  startBreach();
  startGame();
  startPlayers();
  startEconomy();
  startShop();
  startDefenses();
  startProgression();
  startLoadout();
  startStats();
  hooks.newGame.push(newGameForAll);
  startTowers();
  // Every cleared wave is a round survived, whoever launched it.
  hooks.waveCleared.push((waveNo) => roundEnd(waveNo));
  startAuto();
  emit("loaded", { protocol: PROTOCOL, core: coreLocation() ?? null, ...gameStatus() });
});
