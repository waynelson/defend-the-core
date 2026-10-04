// Player monitoring for the DM: a snapshot of everyone online every few
// seconds, plus join, leave, death and respawn events. (Chat comes from the
// optional chat bridge pack, which needs the Beta APIs experiment.)

import { system, world } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { coinsOf } from "./economy.js";
import { CATEGORY_IDS, statsOf } from "./stats.js";
import { progressOf } from "./progression.js";
import { emit, round } from "./util.js";

const SNAPSHOT_TICKS = 100;
let lastSnapshot = "";

function describePlayer(player) {
  const p = player.location;
  const health = player.getComponent("minecraft:health");
  const core = coreLocation();
  let biome;
  try {
    biome = player.dimension.getBiome(p).id.replace("minecraft:", "");
  } catch {
    biome = undefined;
  }
  return {
    name: player.name,
    hp: health ? Math.ceil(health.currentValue) : undefined,
    max: health?.effectiveMax,
    at: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    dim: player.dimension.id.replace("minecraft:", ""),
    mode: String(player.getGameMode()).toLowerCase(),
    biome,
    core_dist:
      core && player.dimension.id === "minecraft:overworld"
        ? round(Math.hypot(p.x - core.x - 0.5, p.z - core.z - 0.5))
        : undefined,
    coins: coinsOf(player),
    ...progressOf(player), // level, xp, next, sp
    skills: Object.fromEntries(CATEGORY_IDS.map((c) => [c, statsOf(player)[c] ?? 1])),
  };
}

export function playerList() {
  return world.getAllPlayers().map(describePlayer);
}

function snapshot(force = false) {
  const players = playerList();
  const key = JSON.stringify(players);
  // Nothing new and nobody online: stay quiet.
  if (!force && key === lastSnapshot && !players.length) return;
  lastSnapshot = key;
  emit("players", { players });
}

export function startPlayers() {
  system.runInterval(() => snapshot(), SNAPSHOT_TICKS);

  world.afterEvents.playerJoin.subscribe((event) => {
    emit("player_join", { name: event.playerName });
  });
  world.afterEvents.playerLeave.subscribe((event) => {
    emit("player_leave", { name: event.playerName });
    system.run(() => snapshot(true));
  });
  world.afterEvents.playerSpawn.subscribe((event) => {
    emit("player_spawn", { name: event.player.name, first: event.initialSpawn });
    snapshot(true);
  });
  world.afterEvents.entityDie.subscribe(
    (event) => {
      const src = event.damageSource;
      const killer = src.damagingEntity;
      emit("player_died", {
        name: event.deadEntity.nameTag || event.deadEntity.typeId,
        cause: src.cause,
        by: killer ? (killer.typeId === "minecraft:player" ? killer.nameTag : killer.typeId) : undefined,
      });
    },
    { entityTypes: ["minecraft:player"] }
  );
  world.afterEvents.playerGameModeChange.subscribe((event) => {
    emit("player_mode", { name: event.player.name, mode: String(event.toGameMode).toLowerCase() });
  });
}
