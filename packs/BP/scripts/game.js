// Game state: phases with optional timers, waves assembled from groups
// (begin -> group... -> commit), spawn scheduling, progress reports and the
// on-screen HUD.

import { system, world } from "@minecraft/server";
import { coreHp } from "./core.js";
import { attackers, spawnCenter, spawnOne, validateSpawn } from "./spawner.js";
import { emit, store, stored } from "./util.js";

const GAME_PROP = "dtc:game";
export const PHASES = ["setup", "prep", "wave", "intermission", "won", "lost"];
const PHASE_TITLES = {
  setup: "§bSetup",
  prep: "§ePrep phase",
  wave: "§cWave",
  intermission: "§aIntermission",
  won: "§aVictory!",
  lost: "§cThe core has fallen",
};
const MAX_GROUPS = 30;
const MAX_WAVE_MOBS = 200;

/** Persisted: {phase, ends_tick?, paused_left?, wave_no} */
// Loaded in startGame(): world properties are unreadable during early execution.
let game = { phase: "setup", wave_no: 0 };
/** In memory only: the wave being assembled or fought. */
let wave;
let lastProgress = "";
let pausedAt;

function save() {
  store(GAME_PROP, game);
}

export function gameStatus() {
  return {
    phase: game.phase,
    seconds_left: secondsLeft(),
    paused: game.paused_left !== undefined,
    wave_no: game.wave_no,
    wave: wave && waveProgress(),
  };
}

function secondsLeft() {
  if (game.paused_left !== undefined) return game.paused_left;
  if (game.ends_tick === undefined) return undefined;
  return Math.max(0, Math.ceil((game.ends_tick - system.currentTick) / 20));
}

// ---------------------------------------------------------------- phases

export function setPhase(phase, durationS, quiet = false) {
  if (!PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES}`);
  if (durationS !== undefined && (typeof durationS !== "number" || durationS < 1 || durationS > 7200)) {
    throw new Error("duration_s must be 1..7200");
  }
  game.phase = phase;
  game.ends_tick = durationS ? system.currentTick + Math.round(durationS * 20) : undefined;
  delete game.paused_left;
  save();
  if (!quiet) {
    const title = phase === "wave" ? `§cWave ${game.wave_no}` : PHASE_TITLES[phase];
    runAll(`title @a title ${title}`);
    if (durationS) runAll(`title @a subtitle §f${clock(durationS)}`);
  }
  emit("phase", { phase, duration_s: durationS ?? null, wave_no: game.wave_no });
  return gameStatus();
}

function runAll(command) {
  try {
    world.getDimension("overworld").runCommand(command);
  } catch {
    // no players online, or a bad command; the HUD is cosmetic
  }
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- waves

export function waveBegin(msg) {
  if (wave && wave.committed && !wave.done) throw new Error(`wave ${wave.id} is still running`);
  if (typeof msg.wave_id !== "string" || !msg.wave_id) throw new Error("wave_id is required");
  wave = {
    id: msg.wave_id,
    final: Boolean(msg.final),
    groups: [],
    committed: false,
    done: false,
    pending: [],
    spawned: 0,
    failed: 0,
    total: 0,
  };
  return { wave_id: wave.id, final: wave.final };
}

export function waveGroup(msg) {
  if (!wave || wave.id !== msg.wave_id) throw new Error(`wave ${msg.wave_id} is not open`);
  if (wave.committed) throw new Error(`wave ${wave.id} is already committed`);
  if (wave.groups.length >= MAX_GROUPS) throw new Error(`at most ${MAX_GROUPS} groups`);
  const count = msg.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("count must be 1..50");
  const interval = msg.interval_s ?? 1;
  if (typeof interval !== "number" || interval < 0 || interval > 60) throw new Error("interval_s must be 0..60");
  const delay = msg.delay_s ?? 0;
  if (typeof delay !== "number" || delay < 0 || delay > 600) throw new Error("delay_s must be 0..600");
  if (wave.total + count > MAX_WAVE_MOBS) throw new Error(`a wave holds at most ${MAX_WAVE_MOBS} mobs`);
  const modules = validateSpawn(msg);
  const spec = {
    mob: msg.mob,
    targeting: msg.targeting,
    point: msg.point,
    bearing: msg.bearing,
    dist: msg.dist,
    x: msg.x,
    z: msg.z,
    spread: msg.spread,
  };
  wave.groups.push({ spec, count, interval, delay, modules });
  wave.total += count;
  return { wave_id: wave.id, groups: wave.groups.length, total: wave.total };
}

export function waveCommit(msg) {
  if (!wave || wave.id !== msg.wave_id) throw new Error(`wave ${msg.wave_id} is not open`);
  if (wave.committed) throw new Error(`wave ${wave.id} is already committed`);
  if (!wave.groups.length) throw new Error("the wave has no groups");
  const now = system.currentTick;
  for (const group of wave.groups) {
    const center = spawnCenter(group.spec);
    for (let i = 0; i < group.count; i++) {
      const at = now + Math.round((group.delay + i * group.interval) * 20);
      wave.pending.push({ at, group, center, tries: 0 });
    }
  }
  wave.pending.sort((a, b) => a.at - b.at);
  wave.committed = true;
  game.wave_no += 1;
  setPhase("wave", undefined, false);
  return { wave_id: wave.id, total: wave.total, wave_no: game.wave_no };
}

function waveMobs() {
  return wave ? attackers().filter((mob) => mob.getDynamicProperty("dtc:wave") === wave.id) : [];
}

function waveProgress() {
  const alive = wave.committed ? waveMobs().length : 0;
  return {
    wave_id: wave.id,
    final: wave.final,
    committed: wave.committed,
    total: wave.total,
    spawned: wave.spawned,
    failed: wave.failed,
    alive,
    killed: wave.spawned - alive,
  };
}

function spawnDue() {
  if (!wave?.committed || wave.done || game.paused_left !== undefined) return;
  const now = system.currentTick;
  while (wave.pending.length && wave.pending[0].at <= now) {
    const item = wave.pending.shift();
    let mob;
    try {
      mob = spawnOne(item.group.spec, item.center, item.group.modules, { "dtc:wave": wave.id });
    } catch (err) {
      emit("spawn_error", { wave_id: wave.id, error: String(err) });
    }
    if (mob) {
      wave.spawned++;
    } else if (++item.tries < 20) {
      // Chunk not loaded yet: try again in a second.
      item.at = now + 20;
      wave.pending.push(item);
      wave.pending.sort((a, b) => a.at - b.at);
      break;
    } else {
      wave.failed++;
    }
  }
}

function checkWaveDone() {
  if (!wave?.committed || wave.done || wave.pending.length) return;
  if (waveMobs().length) return;
  wave.done = true;
  emit("wave_cleared", { ...waveProgress() });
  if (wave.final) {
    setPhase("won");
    emit("game_over", { result: "won" });
  } else {
    setPhase("intermission");
  }
}

export function control(cmd) {
  switch (cmd) {
    case "pause":
      if (game.paused_left === undefined) {
        game.paused_left = secondsLeft() ?? null;
        game.ends_tick = undefined;
        pausedAt = system.currentTick;
        save();
      }
      break;
    case "resume":
      if (game.paused_left !== undefined) {
        if (game.paused_left) game.ends_tick = system.currentTick + game.paused_left * 20;
        delete game.paused_left;
        // Pending spawns keep their spacing: push them back by the pause.
        if (wave && pausedAt !== undefined) {
          const held = system.currentTick - pausedAt;
          for (const item of wave.pending) item.at += held;
        }
        pausedAt = undefined;
        save();
      }
      break;
    case "abort":
      endWave("wave_aborted");
      setPhase("intermission");
      break;
    case "kill_all": {
      // Clearing the field by hand is not a win: a running wave is aborted.
      endWave("wave_aborted");
      const mobs = attackers();
      for (const mob of mobs) mob.remove();
      return { removed: mobs.length, ...gameStatus() };
    }
    default:
      throw new Error("cmd must be pause, resume, abort or kill_all");
  }
  emit("control", { cmd });
  return gameStatus();
}

/** Stops a running wave: no more spawns, its mobs removed, never "cleared". */
function endWave(eventType) {
  if (!wave || wave.done) return;
  wave.pending = [];
  wave.done = true;
  if (wave.committed) for (const mob of waveMobs()) mob.remove();
  emit(eventType, { wave_id: wave.id });
}

/** Called when the core dies; the wave's mobs stay where they are. */
export function coreLost() {
  if (wave && !wave.done) {
    wave.pending = [];
    wave.done = true;
  }
  setPhase("lost");
}

// ---------------------------------------------------------------- loop

function hud() {
  const left = secondsLeft();
  let text;
  if (game.phase === "wave" && wave?.committed && !wave.done) {
    const p = waveProgress();
    text = `§cWave ${game.wave_no}§f  ${p.alive} attacking · ${p.total - p.spawned} incoming`;
  } else if (left !== undefined && left !== null) {
    const color = left <= 30 ? "§c" : left <= 60 ? "§6" : "§e";
    text = `${color}${PHASE_TITLES[game.phase].replace(/§./g, "")}: ${clock(left)}`;
  }
  const hp = coreHp();
  if (hp && game.phase !== "setup") text = `${text ? text + "   " : ""}§bCore §f${hp.hp}/${hp.max}`;
  if (text) runAll(`title @a actionbar ${text}`);

  if (game.ends_tick !== undefined && system.currentTick >= game.ends_tick) {
    game.ends_tick = undefined;
    save();
    runAll("title @a title §cTime's up!");
    runAll("playsound note.pling @a");
    emit("timer_done", { phase: game.phase });
  }
}

function report() {
  if (!wave?.committed || wave.done) return;
  const progress = waveProgress();
  const key = JSON.stringify(progress);
  if (key !== lastProgress) {
    lastProgress = key;
    emit("wave_progress", progress);
  }
}

export function startGame() {
  game = stored(GAME_PROP, game);
  system.runInterval(spawnDue, 5);
  system.runInterval(() => {
    hud();
    checkWaveDone();
  }, 20);
  system.runInterval(report, 40);
}
