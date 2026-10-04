// Game state: phases with optional timers, waves assembled from groups
// (begin -> group... -> commit), spawn scheduling, progress reports and the
// on-screen HUD.

import { system, world } from "@minecraft/server";
import { coreHp } from "./core.js";
import { attackers, spawnCenter, spawnOne, validateSpawn } from "./spawner.js";
import { getConfig } from "./breach.js";
import { payWave } from "./economy.js";
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
const MAX_GROUPS = 40;
const MAX_WAVE_MOBS = 1000;
const MAX_GROUP_MOBS = 200; // also the most of any one mob type in a wave

/** Persisted: {phase, ends_tick?, paused_left?, wave_no} */
// Loaded in startGame(): world properties are unreadable during early execution.
let game = { phase: "setup", wave_no: 0 };
/** In memory only: the wave being assembled or fought. */
let wave;
let lastProgress = "";
/** Listeners other modules add (the auto DM, progression). */
export const hooks = { timerDone: [], waveCleared: [], lost: [], newGame: [] };

/** Per-player HUD lines under the game line: functions (player) -> text. */
export const hudLines = [];

function fire(list, ...args) {
  for (const fn of list) {
    try {
      fn(...args);
    } catch (err) {
      emit("hook_error", { error: String(err) });
    }
  }
}
let pausedAt;

function save() {
  store(GAME_PROP, game);
}

export function gameStatus() {
  return {
    phase: game.phase,
    seconds_left: secondsLeft(),
    // The current phase's timer has run out (and nothing has changed phase
    // since): lets a panel that missed timer_done catch up.
    timer_ended: Boolean(game.timer_ended),
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
  game.timer_ended = false;
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
  if (!Number.isInteger(count) || count < 1 || count > MAX_GROUP_MOBS) throw new Error(`count must be 1..${MAX_GROUP_MOBS}`);
  const sameType = wave.groups.filter((g) => g.spec.mob === msg.mob).reduce((n, g) => n + g.count, 0);
  if (sameType + count > MAX_GROUP_MOBS) throw new Error(`a wave holds at most ${MAX_GROUP_MOBS} ${msg.mob}`);
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
  wave.committed_tick = now;
  game.wave_no += 1;
  setPhase("wave", undefined, false);
  return { wave_id: wave.id, total: wave.total, wave_no: game.wave_no };
}

/** Spawns that are due but waiting for room under the cap. */
function queuedCount(now = system.currentTick) {
  return wave ? wave.pending.filter((item) => item.at <= now).length : 0;
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
    queued: wave.committed ? queuedCount() : 0,
  };
}

// At most this many queued spawns per pass (every 5 ticks), so room made
// by a burst of kills refills gradually.
const SPAWNS_PER_PASS = 6;

function spawnDue() {
  if (!wave?.committed || wave.done || game.paused_left !== undefined) return;
  const now = system.currentTick;
  if (!wave.pending.length || wave.pending[0].at > now) return;
  // The live-attacker cap (DM setting max_alive): due spawns wait their turn.
  const room = getConfig().max_alive - attackers().length;
  if (room <= 0) {
    if (!wave.capped) {
      wave.capped = true;
      emit("wave_capped", { wave_id: wave.id, max_alive: getConfig().max_alive, queued: queuedCount(now) });
    }
    return;
  }
  let budget = Math.min(room, SPAWNS_PER_PASS);
  while (budget > 0 && wave.pending.length && wave.pending[0].at <= now) {
    budget--;
    const item = wave.pending.shift();
    let mob;
    try {
      mob = spawnOne(item.group.spec, item.center, item.group.modules, { "dtc:wave": wave.id });
    } catch (err) {
      emit("spawn_error", { wave_id: wave.id, error: String(err) });
    }
    if (mob) {
      wave.spawned++;
      wave.last_spawn_tick = now;
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
  completeWave();
}

function completeWave() {
  wave.done = true;
  emit("wave_cleared", { ...waveProgress() });
  payWave(game.wave_no);
  const final = wave.final;
  if (final) {
    setPhase("won");
    emit("game_over", { result: "won" });
  } else {
    setPhase("intermission");
  }
  fire(hooks.waveCleared, game.wave_no, final);
}

/** The running wave, for the auto DM: {wave_no, age_s} or undefined. */
export function activeWave() {
  if (!wave?.committed || wave.done) return undefined;
  const now = system.currentTick;
  return {
    wave_no: game.wave_no,
    age_s: (now - wave.committed_tick) / 20,
    // Seconds since the last mob came in (or since launch): a long wave
    // that is still spawning from its queue isn't stuck.
    idle_s: (now - (wave.last_spawn_tick ?? wave.committed_tick)) / 20,
    queued: wave.pending.length,
  };
}

/** Ends a wave that drags on (mobs stuck out of reach) as cleared. */
export function finishWave() {
  if (!wave?.committed || wave.done) return false;
  wave.pending = [];
  const stragglers = waveMobs();
  for (const mob of stragglers) mob.remove();
  emit("wave_timeout", { wave_id: wave.id, removed: stragglers.length });
  completeWave();
  return true;
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

/** Which game this is; players' skills belong to one game. */
export function gameNo() {
  return game.game_no ?? 1;
}

/** A new game: no wave, wave count back to zero, setup phase. */
export function resetGame() {
  endWave("wave_aborted");
  wave = undefined;
  game.wave_no = 0;
  game.game_no = gameNo() + 1;
  setPhase("setup", undefined, true);
  emit("game_reset", { game_no: game.game_no });
  fire(hooks.newGame);
}

/** Called when the core dies; the wave's mobs stay where they are. */
export function coreLost() {
  if (wave && !wave.done) {
    wave.pending = [];
    wave.done = true;
  }
  setPhase("lost");
  fire(hooks.lost);
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
  // One action bar per player: the game line, then their own lines.
  for (const player of world.getAllPlayers()) {
    try {
      const lines = text ? [text] : [];
      for (const line of hudLines) lines.push(line(player));
      if (lines.length) player.onScreenDisplay.setActionBar(lines.join("\n"));
    } catch {
      // left mid-tick
    }
  }

  if (game.ends_tick !== undefined && system.currentTick >= game.ends_tick) {
    game.ends_tick = undefined;
    game.timer_ended = true;
    save();
    runAll("title @a title §cTime's up!");
    runAll("playsound note.pling @a");
    emit("timer_done", { phase: game.phase });
    fire(hooks.timerDone, game.phase);
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
