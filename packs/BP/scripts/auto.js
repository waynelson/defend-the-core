// Auto DM: runs the game on its own. Prep timer -> a generated wave ->
// intermission (with a supply drop) -> the next, harder wave, until the
// final wave is cleared (win), the core falls, or the DM switches it off.
// A wave that drags on (mobs stuck out of reach) is ended after a timeout.

import { system, world } from "@minecraft/server";
import { coreEntity, coreLocation } from "./core.js";
import { restockDepot } from "./depot.js";
import {
  activeWave, finishWave, gameStatus, hooks, resetGame, setPhase, waveBegin, waveCommit, waveGroup,
} from "./game.js";
import { startRain } from "./rewards.js";
import { raiseTower } from "./tower.js";
import { MOBS } from "./roster.js";
import { spawnPoints } from "./spawner.js";
import { emit, store, stored } from "./util.js";

const AUTO_PROP = "dtc:auto";
const DEFAULTS = {
  on: false,
  prep_s: 180, // first prep
  intermission_s: 90, // between waves
  waves: 10, // 0 = endless; the last one is final
  start: 2, // difficulty of wave 1 (1..10)
  step: 0.7, // difficulty added per wave
  max: 10, // difficulty cap
  flyers: true,
  rewards: true, // supply drop every intermission
  restock_every: 3, // restock the depot every N waves (0 = never)
  tower_every: 2, // raise a new tower every N intermissions (0 = never)
  wave_timeout_s: 420, // a wave ends this long after its last mob came in
};
const RANGES = {
  prep_s: [10, 1800], intermission_s: [10, 1800], waves: [0, 100], start: [1, 10], step: [0, 3],
  max: [1, 10], restock_every: [0, 20], tower_every: [0, 20], wave_timeout_s: [60, 1800],
};

// Same power-budget mix as the DM tab's generator.
const COST = {
  "dm:swarmer": 1, "dm:zombie": 1, "dm:skeleton": 2, "dm:digger": 3, "dm:siege_skeleton": 3, "dm:sapper": 4,
  "dm:phantom": 2, "dm:blaze": 3, "dm:ghast": 6,
};
const DELAY = { "dm:digger": 5, "dm:siege_skeleton": 5, "dm:sapper": 15, "dm:blaze": 10, "dm:ghast": 20 };

export function autoConfig() {
  return { ...DEFAULTS, ...stored(AUTO_PROP, {}) };
}

function save(config) {
  store(AUTO_PROP, config);
}

function difficulty(config, waveNo) {
  return Math.min(config.max, config.start + config.step * (waveNo - 1));
}

export function autoStatus() {
  const config = autoConfig();
  const next = gameStatus().wave_no + 1;
  return { ...config, next_wave: next, next_difficulty: Math.round(difficulty(config, next) * 10) / 10 };
}

function weights(d, flyers) {
  return {
    "dm:swarmer": 5,
    "dm:zombie": 3,
    "dm:skeleton": 1,
    "dm:digger": d >= 2 ? 1 + d * 0.6 : 0,
    "dm:siege_skeleton": d >= 3 ? d * 0.4 : 0,
    "dm:sapper": d >= 5 ? (d - 4) * 0.5 : 0,
    "dm:phantom": flyers && d >= 3 ? (d - 2) * 0.35 : 0,
    "dm:blaze": flyers && d >= 4 ? (d - 3) * 0.3 : 0,
    "dm:ghast": flyers && d >= 6 ? (d - 5) * 0.3 : 0,
  };
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Where this wave comes from: some of the saved spawn points, or bearings. */
function places(d) {
  const sides = Math.min(4, 1 + Math.floor(d / 3));
  const names = Object.keys(spawnPoints());
  if (names.length) return shuffle([...names]).slice(0, Math.min(sides, names.length)).map((point) => ({ point }));
  const base = Math.floor(Math.random() * 24) * 15;
  const spread = { 1: [0], 2: [-40, 40], 3: [-60, 0, 60], 4: [0, 90, 180, 270] }[sides];
  return spread.map((o) => ({ bearing: (((base + o) % 360) + 360) % 360, dist: 40 }));
}

// The power budget: gentle early, then steep from difficulty 5 so late
// waves are hundreds strong (about 60 mobs at 7, 150 at 8.3, 460 at 10);
// the max-alive cap turns them into a constant stream.
function generate(d, flyers) {
  const budget = 8 + d * 7 + 6 * Math.max(0, d - 5) ** 3;
  const mix = Object.entries(weights(d, flyers)).filter(([mob, w]) => w > 0 && MOBS[mob]);
  const total = mix.reduce((n, [, w]) => n + w, 0);
  const from = places(d);
  const interval = Math.max(0.3, Math.round((1.5 - d * 0.1) * 10) / 10);
  const groups = [];
  for (const [mob, w] of mix) {
    const count = Math.min(200, Math.round((budget * (w / total)) / COST[mob]));
    from.forEach((place, i) => {
      const share = Math.floor(count / from.length) + (i < count % from.length ? 1 : 0);
      if (share) groups.push({ mob, count: share, interval_s: interval, delay_s: DELAY[mob] ?? 0, ...place });
    });
  }
  if (!groups.length) groups.push({ mob: "dm:zombie", count: 3, ...from[0] });
  return groups;
}

function launchNext() {
  const config = autoConfig();
  const next = gameStatus().wave_no + 1;
  const d = difficulty(config, next);
  const id = `auto${next}`;
  const final = config.waves > 0 && next >= config.waves;
  waveBegin({ wave_id: id, final });
  const groups = generate(d, config.flyers);
  for (const group of groups) waveGroup({ wave_id: id, ...group });
  waveCommit({ wave_id: id });
  const mobs = groups.reduce((n, g) => n + g.count, 0);
  emit("auto_wave", { wave_no: next, difficulty: Math.round(d * 10) / 10, mobs, final });
  world.sendMessage(`§cWave ${next}${final ? " (final)" : ""}§r: ${mobs} attackers incoming!`);
}

function stop(reason) {
  const config = autoConfig();
  if (!config.on) return;
  save({ ...config, on: false });
  emit("auto", { on: false, reason });
}

/** {on?, new_game?, ...settings}: switch the auto DM on or off and/or change settings. */
export function setAuto(msg) {
  const config = autoConfig();
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (msg[key] === undefined) continue;
    const value = msg[key];
    if (typeof value !== "number" || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
    config[key] = value;
  }
  for (const key of ["flyers", "rewards"]) if (msg[key] !== undefined) config[key] = Boolean(msg[key]);
  const turningOn = msg.on === true && !config.on;
  if (msg.on !== undefined) config.on = Boolean(msg.on);
  if (turningOn) {
    if (!coreLocation() || !coreEntity()) throw new Error("place the core first");
    const phase = gameStatus().phase;
    // A finished game, or new_game, starts again from wave 1.
    if (msg.new_game || phase === "won" || phase === "lost") resetGame();
  }
  save(config);
  if (turningOn) {
    const status = gameStatus();
    if (status.phase === "setup" || status.seconds_left == null) setPhase(status.wave_no ? "intermission" : "prep", status.wave_no ? config.intermission_s : config.prep_s);
    world.sendMessage("§6The auto DM is running.§r Get ready!");
  }
  emit("auto", { on: config.on });
  return autoStatus();
}

function onTimerDone(phase) {
  if (autoConfig().on && (phase === "prep" || phase === "intermission")) launchNext();
}

function onWaveCleared(waveNo, final) {
  const config = autoConfig();
  if (!config.on) return;
  if (final) {
    world.sendMessage("§a§lVictory!§r The core held. The auto DM is done.");
    stop("won");
    return;
  }
  setPhase("intermission", config.intermission_s);
  if (config.rewards) {
    try {
      startRain({ count: Math.min(40, 10 + waveNo * 2), radius: 14, duration_s: 6, quality: waveNo < 3 ? 1 : waveNo < 7 ? 2 : 3 });
      world.getDimension("overworld").runCommand("title @a subtitle §6Supply drop at the core!");
    } catch (err) {
      emit("auto_error", { error: String(err) });
    }
  }
  if (config.tower_every && waveNo % config.tower_every === 0) {
    try {
      raiseTower({ difficulty: difficulty(config, waveNo + 1) });
    } catch (err) {
      emit("auto_error", { error: `tower: ${err}` });
    }
  }
  if (config.restock_every && waveNo % config.restock_every === 0) {
    try {
      restockDepot();
      world.sendMessage("§eThe depot has been restocked.");
    } catch {
      // no depot
    }
  }
}

/** Keeps the loop moving whatever happened (DM aborts, restarts...). */
function watchdog() {
  const config = autoConfig();
  if (!config.on) return;
  const status = gameStatus();
  if (status.phase === "won" || status.phase === "lost") return stop(status.phase);
  if (status.paused) return;
  if (status.phase === "setup") return void setPhase("prep", config.prep_s);
  const wave = activeWave();
  if (status.phase === "wave") {
    if (!wave) setPhase("intermission", config.intermission_s);
    else if (!wave.queued && wave.idle_s > config.wave_timeout_s) finishWave();
    return;
  }
  if ((status.phase === "prep" || status.phase === "intermission") && status.seconds_left == null) {
    setPhase(status.phase, status.phase === "prep" ? config.prep_s : config.intermission_s);
  }
}

export function startAuto() {
  hooks.timerDone.push(onTimerDone);
  hooks.waveCleared.push(onWaveCleared);
  hooks.lost.push(() => {
    if (autoConfig().on) world.sendMessage("§c§lThe core has fallen.§r The auto DM has stopped.");
    stop("lost");
  });
  system.runInterval(watchdog, 40);
}
