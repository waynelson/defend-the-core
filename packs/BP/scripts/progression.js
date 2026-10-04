// Player levels: XP from kills (as they happen) and from every round
// survived; level-ups are counted and announced at the end of each round.
// Each level brings skill points, spent at the Arms Dealer on high-end gear.
// XP, level and skill points are scoreboards, so they persist per player.

import { world } from "@minecraft/server";
import { BOUNTY } from "./economy.js";
import { emit, store, stored } from "./util.js";

const PROG_PROP = "dtc:progression";
const DEFAULTS = {
  kill_xp_mult: 1, // XP per kill = bounty x 10 x this
  round_xp_base: 50, // per player per round survived...
  round_xp_step: 25, // ...plus this times the wave number
  sp_per_level: 1,
};
const RANGES = { kill_xp_mult: [0, 20], round_xp_base: [0, 10000], round_xp_step: [0, 1000], sp_per_level: [0, 10] };
const OBJ = { xp: ["dm_xp", "XP"], level: ["dm_level", "Level"], sp: ["dm_sp", "Skill points"] };

export function progressionConfig() {
  return { ...DEFAULTS, ...stored(PROG_PROP, {}) };
}

export function setProgression(changes) {
  const config = progressionConfig();
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (changes[key] === undefined) continue;
    const value = changes[key];
    if (typeof value !== "number" || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
    config[key] = value;
  }
  store(PROG_PROP, config);
  return config;
}

function objective(kind) {
  const [id, name] = OBJ[kind];
  return world.scoreboard.getObjective(id) ?? world.scoreboard.addObjective(id, name);
}

function score(player, kind) {
  try {
    return objective(kind).getScore(player) ?? 0;
  } catch {
    return 0;
  }
}

function setScore(player, kind, value) {
  objective(kind).setScore(player, Math.max(0, Math.round(value)));
}

/** XP needed to go from `level` to the next: 100, 150, 200... */
export function xpForNext(level) {
  return 100 + 50 * (Math.max(1, level) - 1);
}

export function progressOf(player) {
  const level = Math.max(1, score(player, "level"));
  return { level, xp: score(player, "xp"), next: xpForNext(level), sp: score(player, "sp") };
}

export function spendSkillPoints(player, amount) {
  const sp = score(player, "sp");
  if (sp < amount) return false;
  setScore(player, "sp", sp - amount);
  return true;
}

function nameTag(player) {
  try {
    player.nameTag = `§7[Lv ${progressOf(player).level}]§r ${player.name}`;
  } catch {
    // left the game
  }
}

export function addXp(player, amount, reason) {
  if (amount <= 0) return;
  setScore(player, "xp", score(player, "xp") + amount);
  emit("xp", { name: player.name, xp: Math.round(amount), reason });
}

/** XP for an attacker's death, to the player who earned it (if online). */
export function killXp(mobType, playerName) {
  const base = BOUNTY[mobType];
  const player = playerName && world.getAllPlayers().find((p) => p.name === playerName);
  if (base && player) addXp(player, base * 10 * progressionConfig().kill_xp_mult, `kill ${mobType.replace("dm:", "")}`);
}

/** Turn banked XP into levels and skill points; announce any level-ups. */
function settle(player) {
  const config = progressionConfig();
  let level = Math.max(1, score(player, "level"));
  let xp = score(player, "xp");
  let gained = 0;
  while (xp >= xpForNext(level)) {
    xp -= xpForNext(level);
    level += 1;
    gained += 1;
  }
  if (!gained) return;
  setScore(player, "level", level);
  setScore(player, "xp", xp);
  const points = gained * config.sp_per_level;
  setScore(player, "sp", score(player, "sp") + points);
  nameTag(player);
  player.onScreenDisplay.setTitle(`§6Level ${level}!`, { subtitle: `§f+${points} skill point${points === 1 ? "" : "s"}`, fadeInDuration: 5, stayDuration: 50, fadeOutDuration: 10 });
  player.playSound("random.levelup");
  emit("level_up", { name: player.name, level, sp: score(player, "sp") });
}

/** End of a round: round XP for everyone online, then level-ups. */
export function roundEnd(waveNo) {
  const config = progressionConfig();
  const xp = Math.round(config.round_xp_base + config.round_xp_step * waveNo);
  for (const player of world.getAllPlayers()) {
    addXp(player, xp, `round ${waveNo}`);
    settle(player);
  }
}

/** DM: {player|all, xp?, sp?, level?} */
export function grantProgress(msg) {
  const players = msg.all ? world.getAllPlayers() : world.getAllPlayers().filter((p) => p.name === msg.player);
  if (!players.length) throw new Error(msg.all ? "nobody is online" : `${msg.player} is not online`);
  for (const player of players) {
    if (typeof msg.level === "number") setScore(player, "level", Math.max(1, msg.level));
    if (typeof msg.sp === "number") setScore(player, "sp", score(player, "sp") + msg.sp);
    if (typeof msg.xp === "number") addXp(player, msg.xp, "dm");
    settle(player);
    nameTag(player);
  }
  return { players: Object.fromEntries(players.map((p) => [p.name, progressOf(p)])) };
}

export function startProgression() {
  world.afterEvents.playerSpawn.subscribe((event) => nameTag(event.player));
}
